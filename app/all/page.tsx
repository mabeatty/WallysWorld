import { redirect } from "next/navigation";

// /all's content moved to the home page (/) itself -- this just keeps old links working.
export default function AllItemsRedirect() {
  redirect("/");
}
