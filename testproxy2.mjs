import { fetch } from "undici";
const r = await fetch("https://ai-gateway.vercel.sh/v1/models");
console.log("vercel status", r.status, "models", (await r.json()).data?.length);
