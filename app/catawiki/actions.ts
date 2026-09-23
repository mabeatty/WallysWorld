"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rpc } from "@/lib/supabase";

function reason(e: unknown) {
  const text = String((e as Error)?.message ?? e);
  const m = text.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "Could not save. Try again.";
}

function number(formData: FormData, key: string) {
  const cleaned = String(formData.get(key) ?? "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function setCatawikiEstimate(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  let error = "";
  try {
    await rpc("dash_catawiki_set_estimate", {
      p_id: id,
      p_low: number(formData, "low"),
      p_high: number(formData, "high"),
      p_max_bid: number(formData, "max_bid"),
      p_confidence: String(formData.get("confidence") ?? "") || null,
      p_notes: String(formData.get("notes") ?? ""),
      p_sources: String(formData.get("sources") ?? ""),
    });
  } catch (e) {
    error = reason(e);
  }
  revalidatePath("/catawiki");
  revalidatePath(`/catawiki/${id}`);
  redirect(`/catawiki/${encodeURIComponent(id)}?${error ? "error=" + encodeURIComponent(error) : "saved=1"}#estimate`);
}

export async function clearCatawikiEstimate(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  await rpc("dash_catawiki_clear_estimate", { p_id: id });
  revalidatePath("/catawiki");
  revalidatePath(`/catawiki/${id}`);
  redirect(`/catawiki/${encodeURIComponent(id)}?removed=1#estimate`);
}

export async function setCatawikiStarred(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const next = formData.get("next") === "1";
  try {
    await rpc("dash_catawiki_set_starred", { p_id: id, p_starred: next });
  } catch {
    /* best effort -- the star just won't have moved */
  }
  revalidatePath("/catawiki");
  revalidatePath(`/catawiki/${id}`);
}

export async function addCatawikiSeed(formData: FormData) {
  const raw = String(formData.get("url") ?? "").trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "www.catawiki.com") return;
  } catch {
    return;
  }
  const kind = formData.get("kind") === "category" ? "category" : "auction";
  await rpc("dash_add_catawiki_seed", { p_url: raw, p_kind: kind });
  revalidatePath("/setup");
}

export async function removeCatawikiSeed(formData: FormData) {
  await rpc("dash_remove_catawiki_seed", { p_name: String(formData.get("name") ?? "") });
  revalidatePath("/setup");
}

export async function saveCatawikiBidMath(formData: FormData) {
  const pct = (k: string) => {
    const n = Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n / 100 : NaN;
  };
  let error = "";
  try {
    await rpc("dash_set_catawiki_bid_math", { p_margin: pct("margin") });
  } catch (e) {
    error = reason(e);
  }
  revalidatePath("/catawiki");
  revalidatePath("/setup");
  redirect("/setup?" + (error ? "cerror=" + encodeURIComponent(error) : "csaved=1") + "#catawikibidmath");
}
