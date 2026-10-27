import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Links the TV app opens, on the bundle-id scheme prebuild registers:
 * - `com.t3tools.t3code.tv://pair?host=<host>&code=<code>` (or `?url=<pairing URL>`) fills
 *   the pairing form and connects, so a phone or a script can pair the TV without typing.
 * - `com.t3tools.t3code.tv://environment/<environmentId>` opens an environment's threads.
 */
export type TvLink =
  | { readonly kind: "pair"; readonly host: string; readonly code: string }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId };

export function parseTvLink(raw: string): TvLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // `scheme://pair?…` puts "pair" in the host; `scheme:///pair?…` puts it in the path.
  const segments = [url.hostname, ...url.pathname.split("/")].filter((part) => part.length > 0);
  const [route, id] = segments;
  if (route === "pair") {
    const pairingUrl = url.searchParams.get("url");
    return {
      kind: "pair",
      host: pairingUrl ?? url.searchParams.get("host") ?? "",
      code: url.searchParams.get("code") ?? "",
    };
  }
  if (route === "environment" && id) {
    return { kind: "environment", environmentId: decodeURIComponent(id) as EnvironmentId };
  }
  return null;
}
