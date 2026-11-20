import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { isUuid, jsonError } from "./api";

const cookieName = "patio_voz_seller";
const maxAge = 8 * 60 * 60;
const accounts = ["owner", "reviewer"] as const;
type SellerAccount = (typeof accounts)[number];

function getCredentials(account: SellerAccount) {
  const email = (account === "owner" ? process.env.SELLER_DEMO_EMAIL : process.env.SELLER_REVIEW_EMAIL)?.trim().toLowerCase();
  const password = account === "owner" ? process.env.SELLER_DEMO_PASSWORD : process.env.SELLER_REVIEW_PASSWORD;
  const secret = process.env.SELLER_SESSION_SECRET;
  return email && password && secret && secret.length >= 32 ? { email, password, secret } : null;
}

function equals(first: string, second: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(first), hash(second));
}

export function checkSellerCredentials(email: string, password: string): SellerAccount | "invalid" | "unconfigured" {
  const normalizedEmail = email.trim().toLowerCase();
  let configured = false;
  for (const account of accounts) {
    const credentials = getCredentials(account);
    if (!credentials) continue;
    configured = true;
    const emailMatches = equals(normalizedEmail, credentials.email);
    const passwordMatches = equals(password, credentials.password);
    if (emailMatches && passwordMatches) return account;
  }
  return configured ? "invalid" : "unconfigured";
}

function sign(payload: string, account: SellerAccount) {
  const credentials = getCredentials(account);
  if (!credentials) return null;
  return createHmac("sha256", credentials.secret)
    .update(JSON.stringify([credentials.email, credentials.password, payload]))
    .digest("base64url");
}

export function getSellerSession(request: Pick<Request, "headers">): { roundId: string; account: SellerAccount } | null {
  const prefix = `${cookieName}=`;
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!token || token.length > 120) return null;
  const [roundId, expiry, signature, accountSuffix, extra] = token.split(".");
  if (extra !== undefined || (accountSuffix !== undefined && accountSuffix !== "reviewer")) return null;
  if (!isUuid(roundId) || !/^\d{1,12}$/.test(expiry ?? "") || !/^[\w-]{43}$/.test(signature ?? "")) return null;
  if (Number(expiry) <= Math.floor(Date.now() / 1000)) return null;
  const account = accountSuffix ?? "owner";
  const expected = sign(`${roundId}.${expiry}${accountSuffix ? ".reviewer" : ""}`, account);
  return expected && equals(signature, expected) ? { roundId, account } : null;
}

export function getSellerRoundId(request: Pick<Request, "headers">): string | null {
  return getSellerSession(request)?.roundId ?? null;
}

export function setSellerSession(response: NextResponse, roundId: string | null, account: SellerAccount = "owner") {
  let value = "";
  if (roundId) {
    const payload = `${roundId.toLowerCase()}.${Math.floor(Date.now() / 1000) + maxAge}`;
    const suffix = account === "reviewer" ? ".reviewer" : "";
    const signature = sign(payload + suffix, account);
    if (!signature) throw new Error("Seller session is not configured");
    value = `${payload}.${signature}${suffix}`;
  }
  response.cookies.set(cookieName, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: roundId ? maxAge : 0,
  });
}

export function sellerRoundError(request: Request, roundId: string) {
  const authorizedRound = getSellerRoundId(request);
  if (!authorizedRound) return jsonError("Entre para acessar o painel do vendedor.", 401);
  if (!isUuid(roundId)) return jsonError("ID de rodada inválido.", 400);
  if (authorizedRound !== roundId.toLowerCase()) return jsonError("Seu acesso está vinculado a outra rodada.", 403);
  return null;
}
