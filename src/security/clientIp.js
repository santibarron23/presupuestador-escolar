// IP real del cliente, para los límites de uso.
//
// Depende de la plataforma (verificado en producción mandando headers falsos):
//   Railway: familia → edge de Railway → app. req.ip con `trust proxy` = TRUST_PROXY_HOPS (2) da la IP real y no se
//            puede falsificar. CF-Connecting-IP NO se usa: no hay Cloudflare y cualquiera podría mandarlo.
//   Render:  familia → Cloudflare → proxies de Render → app. La cadena X-Forwarded-For termina en nodos de Cloudflare que
//            cambian en cada pedido; la IP real es CF-Connecting-IP, que Cloudflare pisa (uno falso → 403).
//            Se activa solo en Render (RENDER=true) o con TRUST_CF_CONNECTING_IP=1.
const net = require("net");
const config = require("../config");

// IPv6: un mismo cliente suele tener un /64 entero; si no se agrupa, rotar direcciones esquiva el límite.
function normalizeIp(ip) {
  if (!ip) return "unknown";
  ip = String(ip).trim();
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv6(ip)) {
    const parts = expandIPv6(ip);
    return parts ? parts.slice(0, 4).join(":") + "::/64" : ip;
  }
  return ip;
}

function expandIPv6(ip) {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  if (t.some((x) => x.includes(".")) || h.some((x) => x.includes("."))) return null; // IPv4 embebida: se deja como viene
  const missing = 8 - h.length - t.length;
  if (missing < 0) return null;
  return [...h, ...Array(tail !== undefined ? missing : 0).fill("0"), ...t].map((x) => x.toLowerCase().replace(/^0+(?=.)/, ""));
}

function clientIp(req) {
  if (config.abuse.trustCfConnectingIp) {
    const cf = req.get && req.get("cf-connecting-ip");
    if (cf && net.isIP(cf.trim())) return normalizeIp(cf);
  }
  return normalizeIp(req.ip);
}

module.exports = { clientIp, normalizeIp };
