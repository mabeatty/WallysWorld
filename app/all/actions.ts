"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rpc } from "@/lib/supabase";

function reason(e: unknown) {
  const text = String((e as Error)?.message ?? e);
  const m = text.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "Could not save. Try again.";
}

export async function saveFxRate(formData: FormData) {
  const n = Number(String(formData.get("rate") ?? "").replace(/[^0-9.]/g, ""));
  let error = "";
  try {
    if (!Number.isFinite(n)) throw new Error("Enter a number");
    await rpc("dash_set_fx_rate", { p_rate: n });
  } catch (e) {
    error = reason(e);
  }
  revalidatePath("/all");
  revalidatePath("/setup");
  redirect("/setup?" + (error ? "xerror=" + encodeURIComponent(error) : "xsaved=1") + "#fxrate");
}

// Both platforms support starring a lot, but under different RPC names. The combined table
// needs one action regardless of which platform a row came from.
export async function setStarredCombined(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const source = String(formData.get("source") ?? "");
  const next = formData.get("next") === "1";
  const fn = source === "catawiki" ? "dash_catawiki_set_starred" : "dash_set_starred";
  try {
    await rpc(fn, { p_id: id, p_starred: next });
  } catch {
    /* best effort -- the star just won't have moved */
  }
  revalidatePath("/all");
  revalidatePath("/");
  revalidatePath("/catawiki");
  revalidatePath("/followed");
}
