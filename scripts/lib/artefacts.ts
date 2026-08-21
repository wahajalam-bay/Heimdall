/**
 * Generates the stored artefact behind a document record.
 *
 * Document rows created by the seed and the population script describe real
 * business papers — a BOQ, a quotation, a mill certificate — but nothing had
 * written the bytes, so opening one in the application failed. These builders
 * produce a genuine file of the declared type, so every document in the register
 * can actually be viewed and downloaded.
 */

/** Escapes a line for inclusion in a PDF text stream. */
function pdfText(line: string) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** A valid single-page PDF carrying the given heading and lines. */
export function buildPdf(heading: string, lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 16 Tf",
    "56 780 Td",
    `(${pdfText(heading)}) Tj`,
    "/F1 10 Tf",
    "0 -28 Td",
    ...lines.flatMap((l) => [`(${pdfText(l)}) Tj`, "0 -16 Td"]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/** A CSV artefact, quoted so commas and quotes inside cells survive. */
export function buildCsv(headers: string[], rows: Array<Array<string | number>>): Buffer {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

/**
 * A valid baseline JPEG — a single mid-grey 8x8 block. Small enough to inline,
 * real enough that an image viewer opens it.
 */
export function buildJpeg(): Buffer {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwc" +
      "JC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAAIAAgBAREA/8QAFAABAQAAAAAAAAAAAAAA" +
      "AAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAQAAAAAAAAAAAAAAAAAAAAP/xAAUEQEAAAAA" +
      "AAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAB//2Q==",
    "base64",
  );
}
