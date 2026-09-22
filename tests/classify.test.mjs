import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import { GOLDEN } from "./classify.golden.mjs";

const SQL = fs.readFileSync(new URL("../supabase/migrations/0018_coin_classifier_fixes.sql", import.meta.url), "utf8");
const fn = SQL.slice(SQL.indexOf("create or replace function classify_lot"), SQL.indexOf("end $$;", SQL.indexOf("create or replace function classify_lot")) + 7);

test("every known title lands in its category", async () => {
  const db = new PGlite();
  await db.exec(fn);
  const wrong = [];
  for (const [title, want] of GOLDEN) {
    const got = (await db.query("select classify_lot($1) c", [title])).rows[0].c;
    if (got !== want) wrong.push(`${title}\n    wanted ${want}, got ${got}`);
  }
  assert.equal(wrong.length, 0, `\n${wrong.length} of ${GOLDEN.length} misplaced:\n  ` + wrong.join("\n  "));
});
