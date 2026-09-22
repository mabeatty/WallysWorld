import { NextResponse, type NextRequest } from "next/server";

// One shared password protects the whole dashboard (username is ignored).
export function middleware(req: NextRequest) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) {
    return new NextResponse("Set DASHBOARD_PASSWORD in your Vercel project settings to unlock this dashboard.", { status: 503 });
  }
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(":") + 1) === pw) return NextResponse.next();
    } catch {
      /* fall through to 401 */
    }
  }
  return new NextResponse("Password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Auction Arbitrage Dashboard", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
