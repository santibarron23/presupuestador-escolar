// IP real del cliente, para los límites de uso.
//
// En producción el pedido pasa por Cloudflare y por el balanceador de Render antes de llegar acá:
//   familia → Cloudflare → Render → app
// Cloudflare pone la IP de quien se conectó en CF-Connecting-IP (y la pisa si alguien la manda falsa), así que
// es la fuente confiable. Si no está (local, tests), se usa req.ip con `trust proxy` = cantidad de saltos.
// Ojo: con `trust proxy = 1` Express tomaba la IP de un nodo de Cloudflare (cambia entre pedidos y la comparten
// miles de personas), no la de la familia.
const net = require("net");

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
  const cf = req.get && req.get("cf-connecting-ip");
  if (cf && net.isIP(cf.trim())) return normalizeIp(cf);
  return normalizeIp(req.ip);
}

module.exports = { clientIp, normalizeIp };
