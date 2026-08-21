"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  checkRateLimit,
  clearFailures,
  createSession,
  destroySession,
  recordFailure,
  requestContext,
  verifyPassword,
} from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/errors";

const schema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function loginAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = schema.safeParse({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid credentials",
      code: "VALIDATION",
      details: parsed.error.issues.map((i) => i.message),
    };
  }

  const email = parsed.data.email.toLowerCase();
  const { ip, userAgent } = await requestContext();
  const rlKey = `${ip ?? "unknown"}:${email}`;

  const rl = checkRateLimit(rlKey);
  if (!rl.allowed) {
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil((rl.retryAfterSec ?? 60) / 60)} minute(s).`,
      code: "RATE_LIMITED",
    };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Uniform failure message so the endpoint does not reveal which emails exist.
  const failure: ActionResult = { ok: false, error: "Incorrect email or password.", code: "INVALID_CREDENTIALS" };

  if (!user || !user.active) {
    recordFailure(rlKey);
    return failure;
  }
  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) {
    recordFailure(rlKey);
    await writeAudit({
      entityType: "User",
      entityId: user.id,
      entityRef: user.email,
      action: "LOGIN_FAILED",
      actor: { id: user.id, name: user.name },
      ip,
      userAgent,
    });
    return failure;
  }

  clearFailures(rlKey);
  await createSession(user.id, ip ?? undefined, userAgent ?? undefined);
  await writeAudit({
    entityType: "User",
    entityId: user.id,
    entityRef: user.email,
    action: "LOGIN",
    actor: { id: user.id, name: user.name },
    ip,
    userAgent,
  });

  return { ok: true, data: { redirect: "/" }, message: "Signed in." };
}

export async function logoutAction(): Promise<ActionResult> {
  await destroySession();
  return { ok: true, data: null };
}
