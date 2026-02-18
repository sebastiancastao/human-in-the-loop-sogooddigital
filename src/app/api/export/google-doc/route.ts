import { NextResponse } from "next/server";
import { createSign } from "crypto";

type ExportPayload = {
  title?: string;
  content?: string;
};

type GoogleShareConfig = {
  type: "anyone" | "user" | "none";
  role: "reader" | "writer" | "commenter";
  email?: string;
};

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function base64Url(input: string | Buffer): string {
  const b64 = Buffer.from(input).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getGoogleConfig(): {
  clientEmail: string;
  privateKey: string;
  share: GoogleShareConfig;
} {
  const clientEmail =
    getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? getEnv("GOOGLE_CLIENT_EMAIL");
  const rawPrivateKey =
    getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") ?? getEnv("GOOGLE_PRIVATE_KEY");

  if (!clientEmail || !rawPrivateKey) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
    );
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
  const shareTypeRaw = (getEnv("GOOGLE_DOC_SHARE_TYPE") ?? "anyone").toLowerCase();
  const shareRoleRaw = (getEnv("GOOGLE_DOC_SHARE_ROLE") ?? "writer").toLowerCase();
  const shareEmail = getEnv("GOOGLE_DOC_SHARE_EMAIL");

  const type: GoogleShareConfig["type"] =
    shareTypeRaw === "user" || shareTypeRaw === "none" ? shareTypeRaw : "anyone";
  const role: GoogleShareConfig["role"] =
    shareRoleRaw === "reader" || shareRoleRaw === "commenter"
      ? shareRoleRaw
      : "writer";

  return {
    clientEmail,
    privateKey,
    share: { type, role, email: shareEmail },
  };
}

async function getGoogleAccessToken(args: {
  clientEmail: string;
  privateKey: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: args.clientEmail,
    scope:
      "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaim = base64Url(JSON.stringify(claim));
  const signingInput = `${encodedHeader}.${encodedClaim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(args.privateKey);
  const assertion = `${signingInput}.${base64Url(signature)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    throw new Error(`Token request failed (${tokenRes.status}): ${tokenText.slice(0, 500)}`);
  }

  const tokenJson = JSON.parse(tokenText) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("No access_token returned by Google");
  return tokenJson.access_token;
}

async function createDoc(args: {
  accessToken: string;
  title: string;
  content: string;
  share: GoogleShareConfig;
}): Promise<string> {
  const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({ title: args.title }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`Create doc failed (${createRes.status}): ${createText.slice(0, 500)}`);
  }
  const createJson = JSON.parse(createText) as { documentId?: string };
  const docId = createJson.documentId;
  if (!docId) throw new Error("Google returned no documentId");

  const batchRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${args.accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: args.content,
            },
          },
        ],
      }),
    }
  );
  const batchText = await batchRes.text();
  if (!batchRes.ok) {
    throw new Error(`Insert text failed (${batchRes.status}): ${batchText.slice(0, 500)}`);
  }

  if (args.share.type !== "none") {
    const permissionBody =
      args.share.type === "user"
        ? {
            type: "user",
            role: args.share.role,
            emailAddress: args.share.email,
          }
        : {
            type: "anyone",
            role: args.share.role,
          };
    const permRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        docId
      )}/permissions?sendNotificationEmail=false`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${args.accessToken}`,
        },
        body: JSON.stringify(permissionBody),
      }
    );
    if (!permRes.ok) {
      const permText = await permRes.text().catch(() => "");
      throw new Error(
        `Share failed (${permRes.status}): ${permText.slice(0, 500)}`
      );
    }
  }

  return `https://docs.google.com/document/d/${docId}/edit`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as ExportPayload | null;
    const title = (body?.title ?? "").trim() || "SoGood Export";
    const content = (body?.content ?? "").trim();
    if (!content) {
      return NextResponse.json({ error: "Missing export content" }, { status: 400 });
    }

    const cfg = getGoogleConfig();
    if (cfg.share.type === "user" && !cfg.share.email) {
      return NextResponse.json(
        { error: "GOOGLE_DOC_SHARE_EMAIL is required when GOOGLE_DOC_SHARE_TYPE=user" },
        { status: 400 }
      );
    }

    const accessToken = await getGoogleAccessToken({
      clientEmail: cfg.clientEmail,
      privateKey: cfg.privateKey,
    });
    const url = await createDoc({
      accessToken,
      title,
      content,
      share: cfg.share,
    });

    return NextResponse.json({ url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Google export failed";
    const lower = message.toLowerCase();
    const status = message.startsWith("Missing ") ? 400 : 500;
    const code = message.startsWith("Missing ")
      ? "google_config_missing"
      : lower.includes("share failed")
        ? "google_share_failed"
        : lower.includes("token request failed")
          ? "google_auth_failed"
          : lower.includes("create doc failed") || lower.includes("insert text failed")
            ? "google_docs_failed"
            : "google_export_failed";

    return NextResponse.json(
      { error: message, code },
      { status }
    );
  }
}
