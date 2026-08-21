"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { userHasPermission } from "@/lib/rbac";
import { PERMISSIONS as P, ROLE_DEFINITIONS } from "@/lib/permissions";
import { CONFIG_DEFS, setConfig } from "@/lib/config";
import { writeAudit } from "@/lib/audit";
import { flushOutbox } from "@/lib/mail";
import { ForbiddenError, NotFoundError, toActionError, ValidationError, type ActionResult } from "@/lib/errors";

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const num = (v: FormDataEntryValue | null) => {
  const s = blank(v);
  return s === null ? null : Number(s);
};
const bool = (v: FormDataEntryValue | null) => v === "on" || v === "true";

async function requireAdmin(...perms: string[]) {
  const user = await requireUser();
  if (!userHasPermission(user, ...perms)) {
    throw new ForbiddenError("You do not have permission to change this configuration.");
  }
  return user;
}

/* ── Configuration ────────────────────────────────────────── */

export async function saveConfigAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.CONFIG_MANAGE);
    const key = String(formData.get("key") ?? "");
    const def = CONFIG_DEFS.find((d) => d.key === key);
    if (!def) throw new ValidationError(`Unknown setting "${key}".`);

    const entityId = blank(formData.get("entityId"));
    const raw = formData.get("value");
    const reason = blank(formData.get("reason"));
    if (!reason) throw new ValidationError("Record why this policy is changing — configuration changes are audited.");

    let value: unknown;
    if (def.valueType === "boolean") {
      value = bool(raw);
    } else if (def.valueType === "number") {
      const n = num(raw);
      if (n === null || Number.isNaN(n)) throw new ValidationError("Enter a number.");
      if (n < 0) throw new ValidationError("A negative value is not meaningful for this setting.");
      value = n;
    } else if (def.valueType === "json") {
      // Comma-separated in the form; stored as a JSON array.
      const text = String(raw ?? "").trim();
      if (text.startsWith("[") || text.startsWith("{")) {
        try {
          value = JSON.parse(text);
        } catch {
          throw new ValidationError("That is not valid JSON.");
        }
      } else {
        value = text
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      }
    } else {
      value = String(raw ?? "");
    }

    await setConfig(key, value, entityId, user.id);
    await writeAudit({
      entityType: "ConfigSetting",
      entityId: key,
      entityRef: def.label,
      action: "CONFIG_UPDATED",
      newValue: { key, value, entityId },
      reason,
      actor: user,
    });
    revalidatePath("/admin/policies");
    revalidatePath("/settings");
    return {
      ok: true,
      data: null,
      message: `${def.label} updated${entityId ? " for this entity" : " globally"}.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resetConfigAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.CONFIG_MANAGE);
    const key = String(formData.get("key") ?? "");
    const entityId = blank(formData.get("entityId"));
    const def = CONFIG_DEFS.find((d) => d.key === key);
    if (!def) throw new ValidationError(`Unknown setting "${key}".`);

    const existing = await prisma.configSetting.findFirst({ where: { key, entityId } });
    if (!existing) throw new ValidationError("There is no override to remove at this level.");
    await prisma.configSetting.delete({ where: { id: existing.id } });
    await writeAudit({
      entityType: "ConfigSetting",
      entityId: existing.id,
      entityRef: key,
      action: "CONFIG_OVERRIDE_REMOVED",
      oldValue: existing.value,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/policies");
    return {
      ok: true,
      data: null,
      message: entityId
        ? `${def.label} now follows the global setting.`
        : `${def.label} now follows the seeded default.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Users and roles ──────────────────────────────────────── */

export async function saveUserAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.USER_MANAGE);
    const userId = blank(formData.get("userId"));
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!email || !email.includes("@")) throw new ValidationError("Enter a valid email address.");
    if (!name) throw new ValidationError("Enter the person's name.");

    const roleIds = formData.getAll("roleIds").map(String).filter(Boolean);
    const entityIds = formData.getAll("entityIds").map(String).filter(Boolean);
    const primaryEntityId = blank(formData.get("primaryEntityId"));
    const data = {
      email,
      name,
      title: blank(formData.get("title")),
      phone: blank(formData.get("phone")),
      primaryDepartmentId: blank(formData.get("departmentId")),
      primaryEntityId,
      active: bool(formData.get("active")),
    };

    if (userId) {
      const before = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true, active: true } });
      if (!before) throw new NotFoundError("User");
      await prisma.user.update({ where: { id: userId }, data });
      await prisma.userRole.deleteMany({ where: { userId } });
      if (roleIds.length) {
        await prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId, roleId })) });
      }
      await prisma.userEntityAccess.deleteMany({ where: { userId } });
      if (entityIds.length) {
        await prisma.userEntityAccess.createMany({
          data: entityIds.map((entityId) => ({ userId, entityId })),
        });
      }
      await writeAudit({
        entityType: "User",
        entityId: userId,
        entityRef: email,
        action: "USER_UPDATED",
        changes: {
          email: { from: before.email, to: email },
          name: { from: before.name, to: name },
          active: { from: before.active, to: data.active },
        },
        newValue: { roles: roleIds.length, entities: entityIds.length },
        reason: blank(formData.get("reason")),
        actor: user,
      });
      revalidatePath("/admin/users");
      return { ok: true, data: { id: userId }, message: `${name} updated.` };
    }

    const password = String(formData.get("password") ?? "");
    if (password.length < 8) throw new ValidationError("Set an initial password of at least 8 characters.");
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ValidationError(`${email} already has an account.`);

    const created = await prisma.user.create({
      data: { ...data, passwordHash: await bcrypt.hash(password, 10) },
    });
    if (roleIds.length) {
      await prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: created.id, roleId })) });
    }
    if (entityIds.length) {
      await prisma.userEntityAccess.createMany({
        data: entityIds.map((entityId) => ({ userId: created.id, entityId })),
      });
    }
    await writeAudit({
      entityType: "User",
      entityId: created.id,
      entityRef: email,
      action: "USER_CREATED",
      newValue: { name, roles: roleIds.length, entities: entityIds.length },
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/users");
    return { ok: true, data: { id: created.id }, message: `${name} created with ${roleIds.length} role(s).` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resetPasswordAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.USER_MANAGE);
    const userId = String(formData.get("userId") ?? "");
    const password = String(formData.get("password") ?? "");
    if (password.length < 8) throw new ValidationError("The new password must be at least 8 characters.");
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!target) throw new NotFoundError("User");

    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    // Existing sessions are revoked so a reset actually locks the account out.
    await prisma.session.deleteMany({ where: { userId } });
    await writeAudit({
      entityType: "User",
      entityId: userId,
      entityRef: target.email,
      action: "USER_PASSWORD_RESET",
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/users");
    return {
      ok: true,
      data: null,
      message: `Password reset for ${target.name}. Their existing sessions have been revoked.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function toggleUserAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.USER_MANAGE);
    const userId = String(formData.get("userId") ?? "");
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { active: true, name: true, email: true } });
    if (!target) throw new NotFoundError("User");
    if (userId === user.id) throw new ValidationError("You cannot deactivate your own account.");

    await prisma.user.update({ where: { id: userId }, data: { active: !target.active } });
    if (target.active) await prisma.session.deleteMany({ where: { userId } });
    await writeAudit({
      entityType: "User",
      entityId: userId,
      entityRef: target.email,
      action: target.active ? "USER_DEACTIVATED" : "USER_REACTIVATED",
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/users");
    return {
      ok: true,
      data: null,
      message: target.active
        ? `${target.name} deactivated and signed out everywhere.`
        : `${target.name} reactivated.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveRoleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.ROLE_MANAGE);
    const roleId = String(formData.get("roleId") ?? "");
    const permissions = formData.getAll("permissions").map(String).filter(Boolean);
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { code: true, name: true } });
    if (!role) throw new NotFoundError("Role");
    const reason = blank(formData.get("reason"));
    if (!reason) throw new ValidationError("Record why this role's authority is changing.");

    // Permissions are stored as rows against the Permission table, so codes are
    // resolved to ids and anything unknown is rejected rather than silently dropped.
    const known = await prisma.permission.findMany({
      where: { code: { in: permissions } },
      select: { id: true, code: true },
    });
    const unknown = permissions.filter((c) => !known.some((k) => k.code === c));
    if (unknown.length) throw new ValidationError(`Unknown permission code(s): ${unknown.join(", ")}.`);

    const before = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    const beforeCodes = before.map((b) => b.permission.code);
    await prisma.rolePermission.deleteMany({ where: { roleId } });
    if (known.length) {
      await prisma.rolePermission.createMany({
        data: known.map((k) => ({ roleId, permissionId: k.id })),
      });
    }
    const added = permissions.filter((c) => !beforeCodes.includes(c));
    const removed = beforeCodes.filter((c) => !permissions.includes(c));

    await writeAudit({
      entityType: "Role",
      entityId: roleId,
      entityRef: role.code,
      action: "ROLE_PERMISSIONS_UPDATED",
      newValue: { added, removed, total: permissions.length },
      reason,
      actor: user,
    });
    revalidatePath("/admin/roles");
    return {
      ok: true,
      data: null,
      message: `${role.name}: ${added.length} permission(s) granted, ${removed.length} revoked.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function restoreRoleDefaultsAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.ROLE_MANAGE);
    const roleId = String(formData.get("roleId") ?? "");
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { code: true, name: true } });
    if (!role) throw new NotFoundError("Role");
    const def = ROLE_DEFINITIONS.find((r) => r.code === role.code);
    if (!def) throw new ValidationError(`${role.name} has no shipped default to restore.`);

    const defaults = await prisma.permission.findMany({
      where: { code: { in: def.permissions } },
      select: { id: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId } });
    await prisma.rolePermission.createMany({
      data: defaults.map((d) => ({ roleId, permissionId: d.id })),
    });
    await writeAudit({
      entityType: "Role",
      entityId: roleId,
      entityRef: role.code,
      action: "ROLE_DEFAULTS_RESTORED",
      newValue: { permissions: def.permissions.length },
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/roles");
    return { ok: true, data: null, message: `${role.name} restored to its shipped ${def.permissions.length} permissions.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Master data ──────────────────────────────────────────── */

export async function saveEntityAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!code) throw new ValidationError("Enter a short entity code.");
    if (!name) throw new ValidationError("Enter the entity name.");
    const data = {
      code,
      name,
      legalName: blank(formData.get("legalName")),
      taxNumber: blank(formData.get("taxNumber")),
      logoText: blank(formData.get("logoText")),
      address: blank(formData.get("address")),
      city: blank(formData.get("city")),
      currency: String(formData.get("currency") ?? "PKR"),
      active: bool(formData.get("active")),
    };

    const saved = id
      ? await prisma.entity.update({ where: { id }, data })
      : await prisma.entity.create({ data });
    await writeAudit({
      entityType: "Entity",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "ENTITY_UPDATED" : "ENTITY_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/entities");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveDepartmentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const entityId = String(formData.get("entityId") ?? "");
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!entityId) throw new ValidationError("Select the entity this department belongs to.");
    if (!code || !name) throw new ValidationError("A department needs both a code and a name.");
    const data = {
      entityId,
      code,
      name,
      headId: blank(formData.get("headId")),
      costCenter: blank(formData.get("costCentre")),
      active: bool(formData.get("active")),
    };
    const saved = id
      ? await prisma.department.update({ where: { id }, data })
      : await prisma.department.create({ data });
    await writeAudit({
      entityType: "Department",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "DEPARTMENT_UPDATED" : "DEPARTMENT_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/departments");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveProjectAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const entityId = String(formData.get("entityId") ?? "");
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!entityId) throw new ValidationError("Select the entity that owns this project.");
    if (!code || !name) throw new ValidationError("A project needs both a code and a name.");
    const startRaw = blank(formData.get("startDate"));
    const endRaw = blank(formData.get("endDate"));
    const data = {
      entityId,
      code,
      name,
      city: blank(formData.get("city")),
      managerId: blank(formData.get("managerId")),
      budget: num(formData.get("budget")),
      status: String(formData.get("status") ?? "Active"),
      startDate: startRaw ? new Date(startRaw) : null,
      endDate: endRaw ? new Date(endRaw) : null,
    };
    const saved = id
      ? await prisma.project.update({ where: { id }, data })
      : await prisma.project.create({ data });
    await writeAudit({
      entityType: "Project",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "PROJECT_UPDATED" : "PROJECT_CREATED",
      newValue: { ...data, startDate: startRaw, endDate: endRaw },
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/projects");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveStoreAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const entityId = String(formData.get("entityId") ?? "");
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!entityId) throw new ValidationError("Select the entity that owns this store.");
    if (!code || !name) throw new ValidationError("A store needs both a code and a name.");
    const data = {
      entityId,
      code,
      name,
      kind: String(formData.get("kind") ?? "OTHER"),
      siteId: blank(formData.get("siteId")),
      projectId: blank(formData.get("projectId")),
      address: blank(formData.get("address")),
      city: blank(formData.get("city")),
      managerId: blank(formData.get("managerId")),
      active: bool(formData.get("active")),
    };
    const saved = id ? await prisma.store.update({ where: { id }, data }) : await prisma.store.create({ data });
    await writeAudit({
      entityType: "Store",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "STORE_UPDATED" : "STORE_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/stores");
    revalidatePath("/stores");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveCategoryAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!code || !name) throw new ValidationError("A category needs both a code and a name.");
    const data = {
      code,
      name,
      entityId: blank(formData.get("entityId")),
      parentId: blank(formData.get("parentId")),
      requiresInspection: bool(formData.get("requiresInspection")),
      inspectionTemplate: blank(formData.get("inspectionTemplate")),
      defaultDisposition: String(formData.get("defaultDisposition") ?? "INVENTORY"),
      assetTagRequired: bool(formData.get("assetTagRequired")),
      active: bool(formData.get("active")),
    };
    const saved = id ? await prisma.category.update({ where: { id }, data }) : await prisma.category.create({ data });
    await writeAudit({
      entityType: "Category",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "CATEGORY_UPDATED" : "CATEGORY_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/catalogue");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveItemAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const sku = String(formData.get("sku") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    const categoryId = String(formData.get("categoryId") ?? "");
    if (!sku || !name) throw new ValidationError("An item needs both an SKU and a name.");
    if (!categoryId) throw new ValidationError("Select the category this item belongs to.");
    const data = {
      sku,
      name,
      description: blank(formData.get("description")),
      categoryId,
      unit: String(formData.get("unit") ?? "EA"),
      brand: blank(formData.get("brand")),
      model: blank(formData.get("model")),
      make: blank(formData.get("make")),
      specification: blank(formData.get("specification")),
      hsCode: blank(formData.get("hsCode")),
      standardPrice: num(formData.get("standardPrice")),
      trackSerial: bool(formData.get("trackSerial")),
      trackBatch: bool(formData.get("trackBatch")),
      trackExpiry: bool(formData.get("trackExpiry")),
      reorderLevel: num(formData.get("reorderLevel")),
      active: bool(formData.get("active")),
    };
    const saved = id ? await prisma.item.update({ where: { id }, data }) : await prisma.item.create({ data });
    await writeAudit({
      entityType: "Item",
      entityId: saved.id,
      entityRef: saved.sku,
      action: id ? "ITEM_UPDATED" : "ITEM_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/catalogue");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveCriterionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!code || !name) throw new ValidationError("A criterion needs both a code and a name.");
    const maxScore = num(formData.get("maxScore")) ?? 3;
    const weight = num(formData.get("weight")) ?? 1;
    if (maxScore <= 0) throw new ValidationError("The maximum score must be greater than zero.");
    if (weight <= 0) throw new ValidationError("The weight must be greater than zero.");
    const data = {
      code,
      name,
      description: blank(formData.get("description")),
      maxScore,
      weight,
      group: String(formData.get("group") ?? "General"),
      sequence: num(formData.get("sequence")) ?? 0,
      active: bool(formData.get("active")),
    };
    const saved = id
      ? await prisma.evaluationCriterion.update({ where: { id }, data })
      : await prisma.evaluationCriterion.create({ data });
    await writeAudit({
      entityType: "EvaluationCriterion",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "CRITERION_UPDATED" : "CRITERION_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/evaluation-criteria");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function saveDocumentTypeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.MASTER_DATA_MANAGE);
    const id = blank(formData.get("id"));
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    const name = String(formData.get("name") ?? "").trim();
    if (!code || !name) throw new ValidationError("A document type needs both a code and a name.");
    // appliesTo is stored as a JSON array of document contexts.
    const appliesTo = formData.getAll("appliesTo").map(String).filter(Boolean);
    const data = {
      code,
      name,
      category: String(formData.get("category") ?? "General"),
      appliesTo: JSON.stringify(appliesTo.length ? appliesTo : ["OTHER"]),
      required: bool(formData.get("mandatory")),
      maxSizeMb: num(formData.get("maxSizeMb")) ?? 20,
      allowedExtensions: String(
        formData.get("allowedExtensions") ?? "pdf,png,jpg,jpeg,xlsx,xls,docx,doc,dwg,csv",
      ),
      retentionMonths: num(formData.get("retentionMonths")),
      viewPermission: blank(formData.get("viewPermission")),
      active: bool(formData.get("active")),
    };
    const saved = id
      ? await prisma.documentType.update({ where: { id }, data })
      : await prisma.documentType.create({ data });
    await writeAudit({
      entityType: "DocumentType",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "DOCUMENT_TYPE_UPDATED" : "DOCUMENT_TYPE_CREATED",
      newValue: data,
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/document-types");
    return { ok: true, data: { id: saved.id }, message: `${saved.name} saved.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Approval rules ───────────────────────────────────────── */

export async function saveApprovalRuleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.APPROVAL_RULE_MANAGE);
    const id = blank(formData.get("id"));
    const name = String(formData.get("name") ?? "").trim();
    const documentType = String(formData.get("documentType") ?? "");
    if (!name) throw new ValidationError("Give the rule a name.");
    if (!documentType) throw new ValidationError("Select the document type this rule governs.");
    const reason = blank(formData.get("reason"));
    if (!reason) throw new ValidationError("Record why the approval chain is changing.");

    type StepInput = {
      sequence?: number;
      name?: string;
      roleId?: string | null;
      approverType?: string;
      slaHours?: number | null;
      requireAll?: boolean;
      optional?: boolean;
      commentRequired?: boolean;
    };
    let steps: StepInput[];
    try {
      steps = JSON.parse(String(formData.get("steps") ?? "[]")) as StepInput[];
    } catch {
      throw new ValidationError("Approval steps could not be read.");
    }
    steps = steps.filter((st) => (st.approverType && st.approverType !== "ROLE") || st.roleId);
    if (!steps.length) {
      throw new ValidationError("An approval rule needs at least one step with an approver.");
    }

    const minAmount = num(formData.get("minAmount")) ?? 0;
    const maxAmount = num(formData.get("maxAmount"));
    if (maxAmount !== null && maxAmount <= minAmount) {
      throw new ValidationError("The upper bound must be above the lower bound.");
    }

    const code =
      blank(formData.get("code")) ??
      `${documentType}_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`.slice(0, 60);

    const data = {
      name,
      description: blank(formData.get("description")),
      documentType,
      entityId: blank(formData.get("entityId")),
      departmentId: blank(formData.get("departmentId")),
      categoryId: blank(formData.get("categoryId")),
      procurementType: blank(formData.get("procurementType")),
      minAmount,
      maxAmount,
      priority: num(formData.get("priority")) ?? 100,
      requiresCpc: bool(formData.get("requiresCpc")),
      active: bool(formData.get("active")),
    };

    const saved = id
      ? await prisma.approvalRule.update({ where: { id }, data })
      : await prisma.approvalRule.create({ data: { ...data, code } });

    await prisma.approvalRuleStep.deleteMany({ where: { ruleId: saved.id } });
    await prisma.approvalRuleStep.createMany({
      data: steps.map((st, i) => ({
        ruleId: saved.id,
        sequence: st.sequence ?? i + 1,
        name: st.name?.trim() || `Step ${i + 1}`,
        roleId: st.approverType && st.approverType !== "ROLE" ? null : (st.roleId ?? null),
        approverType: st.approverType ?? "ROLE",
        slaHours: st.slaHours ?? 24,
        requireAll: Boolean(st.requireAll),
        optional: Boolean(st.optional),
        commentRequired: Boolean(st.commentRequired),
      })),
    });

    await writeAudit({
      entityType: "ApprovalRule",
      entityId: saved.id,
      entityRef: saved.code,
      action: id ? "APPROVAL_RULE_UPDATED" : "APPROVAL_RULE_CREATED",
      newValue: {
        ...data,
        steps: steps.map((st, i) => ({
          sequence: st.sequence ?? i + 1,
          name: st.name,
          approverType: st.approverType ?? "ROLE",
        })),
      },
      reason,
      actor: user,
    });
    revalidatePath("/admin/approval-rules");
    return {
      ok: true,
      data: { id: saved.id },
      message: `${saved.name} saved with ${steps.length} approval step(s).`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function toggleApprovalRuleAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireAdmin(P.APPROVAL_RULE_MANAGE);
    const id = String(formData.get("id") ?? "");
    const rule = await prisma.approvalRule.findUnique({ where: { id }, select: { active: true, name: true } });
    if (!rule) throw new NotFoundError("Approval rule");
    await prisma.approvalRule.update({ where: { id }, data: { active: !rule.active } });
    await writeAudit({
      entityType: "ApprovalRule",
      entityId: id,
      entityRef: rule.name,
      action: rule.active ? "APPROVAL_RULE_DISABLED" : "APPROVAL_RULE_ENABLED",
      reason: blank(formData.get("reason")),
      actor: user,
    });
    revalidatePath("/admin/approval-rules");
    return { ok: true, data: null, message: `${rule.name} ${rule.active ? "disabled" : "enabled"}.` };
  } catch (e) {
    return toActionError(e);
  }
}

/* ── Options ──────────────────────────────────────────────── */

export async function adminOptions() {
  await requireUser();
  const [entities, departments, categories, users, sites, projects, roles] = await Promise.all([
    prisma.entity.findMany({ select: { id: true, code: true, name: true, active: true }, orderBy: { code: "asc" } }),
    prisma.department.findMany({
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
    prisma.site.findMany({ select: { id: true, code: true, name: true, entityId: true }, orderBy: { name: "asc" } }),
    prisma.project.findMany({
      select: { id: true, code: true, name: true, entityId: true },
      orderBy: { name: "asc" },
    }),
    prisma.role.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { entities, departments, categories, users, sites, projects, roles };
}

/* ── Email delivery ───────────────────────────────────────── */

/**
 * Sends whatever is queued. Exposed to administrators because an outbox nobody
 * can push is just a list of things that did not happen.
 */
export async function flushMailAction(_formData: FormData): Promise<ActionResult> {
  const user = await requireAdmin(P.CONFIG_MANAGE);
  const result = await flushOutbox(200);
  await writeAudit({
    entityType: "EmailMessage",
    entityId: "outbox",
    entityRef: "Email outbox",
    action: "EMAIL_OUTBOX_FLUSHED",
    newValue: result,
    actor: user,
  });
  revalidatePath("/admin/email");
  const detail = `${result.sent} sent, ${result.failed} failed via the ${result.transport} transport.`;
  if (result.failed && !result.sent) {
    return { ok: false, error: result.errors[0] ?? detail, code: "MAIL_TRANSPORT" };
  }
  return { ok: true, data: result, message: result.attempted ? detail : "Nothing was waiting to be sent." };
}

/** Requeues a failed message so a transient fault can be retried on purpose. */
export async function requeueMailAction(formData: FormData): Promise<ActionResult> {
  const user = await requireAdmin(P.CONFIG_MANAGE);
  const id = String(formData.get("id") ?? "");
  const message = await prisma.emailMessage.findUnique({ where: { id } });
  if (!message) throw new NotFoundError("Email message");
  await prisma.emailMessage.update({
    where: { id },
    data: { status: "QUEUED", attempts: 0, lastError: null, failedAt: null },
  });
  await writeAudit({
    entityType: "EmailMessage",
    entityId: id,
    entityRef: message.subject,
    action: "EMAIL_REQUEUED",
    oldValue: { status: message.status, attempts: message.attempts },
    newValue: { status: "QUEUED", attempts: 0 },
    actor: user,
  });
  revalidatePath("/admin/email");
  return { ok: true, data: null, message: `${message.subject} is queued again.` };
}
