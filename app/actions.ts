"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rpc } from "@/lib/supabase";

export async function resume() {
  await rpc("dash_resume");
  revalidatePath("/");
}

export async function setPaused(formData: FormData) {
  await rpc("dash_set_paused", { p_paused: formData.get("pause") === "1" });
  revalidatePath("/");
}

export async function addSeed(formData: FormData) {
  const raw = String(formData.get("url") ?? "").trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "www.ebth.com") return;
  } catch {
    return;
  }
  await rpc("dash_add_seed", { p_url: raw, p_login: formData.get("login") === "on" });
  revalidatePath("/setup");
}

export async function removeSeed(formData: FormData) {
  await rpc("dash_remove_seed", { p_name: String(formData.get("name") ?? "") });
  revalidatePath("/setup");
}

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

export async function saveEstimate(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  let error = "";
  try {
    await rpc("dash_set_estimate", {
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
  revalidatePath("/");
  revalidatePath("/lots");
  revalidatePath(`/lots/${id}`);
  redirect(`/lots/${encodeURIComponent(id)}?${error ? "error=" + encodeURIComponent(error) : "saved=1"}#estimate`);
}

export async function clearEstimate(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  await rpc("dash_clear_estimate", { p_id: id });
  revalidatePath("/");
  revalidatePath("/lots");
  revalidatePath(`/lots/${id}`);
  redirect(`/lots/${encodeURIComponent(id)}?removed=1#estimate`);
}

function safePath(raw: string) {
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export async function refreshBids(formData: FormData) {
  const ids = formData.getAll("id").map(String).filter(Boolean);
  const returnTo = safePath(String(formData.get("returnTo") ?? "/"));
  const anchor = String(formData.get("anchor") ?? "").replace(/[^a-z0-9_-]/gi, "");
  const u = new URL(returnTo, "http://local");
  try {
    const r = await rpc<{ queued: number }>("dash_request_refresh", { p_ids: ids });
    u.searchParams.set("refreshed", String(r.queued));
    u.searchParams.delete("rerror");
  } catch (e) {
    u.searchParams.set("rerror", reason(e));
    u.searchParams.delete("refreshed");
  }
  revalidatePath("/");
  revalidatePath("/lots");
  redirect(u.pathname + u.search + (anchor ? "#" + anchor : ""));
}

export async function saveBidMath(formData: FormData) {
  const pct = (k: string) => {
    const n = Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n / 100 : NaN;
  };
  let error = "";
  try {
    await rpc("dash_set_bid_math", { p_premium: pct("premium"), p_margin: pct("margin") });
  } catch (e) {
    error = reason(e);
  }
  revalidatePath("/");
  revalidatePath("/lots");
  revalidatePath("/setup");
  redirect("/setup?" + (error ? "error=" + encodeURIComponent(error) : "saved=1") + "#bidmath");
}
