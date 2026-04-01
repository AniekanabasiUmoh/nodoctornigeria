import fs from "node:fs";
import path from "node:path";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const inputPath = process.argv[2] ?? "build/nstg_dataset_chunks.jsonl";
const batchSize = Number(process.argv[3] ?? 200);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const resolvedInputPath = path.resolve(inputPath);
if (!fs.existsSync(resolvedInputPath)) {
  console.error(`Input file not found: ${resolvedInputPath}`);
  process.exit(1);
}

const lines = fs
  .readFileSync(resolvedInputPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const deduped = new Map();
for (const line of lines) {
  const chunk = JSON.parse(line);
  deduped.set(chunk.chunk_id, {
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    word_count: chunk.word_count,
    metadata: chunk.metadata,
  });
}

const records = [...deduped.values()];

console.log(`Importing ${records.length} chunks from ${resolvedInputPath}`);

for (let offset = 0; offset < records.length; offset += batchSize) {
  const batch = records.slice(offset, offset + batchSize);
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/guideline_chunks`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`Batch starting at ${offset} failed: ${response.status} ${detail}`);
    process.exit(1);
  }

  console.log(`Imported ${Math.min(offset + batch.length, records.length)} / ${records.length}`);
}

console.log("Guideline chunk import completed.");
