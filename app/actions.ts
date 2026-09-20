"use server";

import { revalidatePath } from "next/cache";
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
