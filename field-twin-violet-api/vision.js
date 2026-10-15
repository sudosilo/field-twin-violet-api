// Field Twin Violet API v1
// BLUE PHONE: reads manifests, box labels, part labels, serial plates, and parts with the Anthropic API.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.VISION_MODEL || "claude-sonnet-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function visionReady() {
  return client !== null;
}

const SYSTEM = [
  "You read photos taken by a field service technician who repairs package lockers.",
  "Photos show shipping manifests or packing slips, box labels, part labels, serial plates, tools, consumables such as lubricants and cleaners, or the parts themselves.",
  "Copy identifying numbers exactly as printed, character for character. Never guess, complete, or correct a number you cannot fully read: leave that field empty and give it a confidence of 0.",
  "Characters that are easy to confuse (0 and O, 1 and I and L, 5 and S, 8 and B, 2 and Z, 6 and G) must be copied as printed; if you are not sure which one it is, lower the confidence for that field below 0.6.",
  "If a barcode value decoded on the phone is supplied, prefer it over your own reading of the same number and give that field confidence 1.",
  "Reply with only one JSON object, no markdown fences, no commentary, in exactly this shape:",
  '{"source":"manifest|box|label|part|other","shipment":{"vendor":"","tracking":"","po":"","order":"","date":""},"items":[{"name":"","kind":"part|tool|consumable","part_number":"","serial":"","manufacturer":"","model":"","quantity":1,"unit":"each","other_ids":[{"label":"","value":""}],"confidence":{"name":0,"part_number":0,"serial":0,"quantity":0}}],"notes":""}',
  "source: manifest for packing slips and shipping manifests, box for labels on boxes and bags, label for a label or plate on a part, part for a photo of the part itself with no readable label, other for anything else.",
  "items: one entry per distinct item. A manifest gets one entry per line item with its quantity. A single label or part gets one entry. If nothing is identifiable, return an empty items array.",
  "name: a short plain description of the item, from the label if printed, otherwise from what is visible.",
  "kind: part for components that get installed, tool for reusable tools, consumable for anything used up such as lubricant, cleaner, tape, zip ties, fasteners, labels.",
  "other_ids: every other identifying number you can read, such as asset tags, lot numbers, revision codes, MAC addresses, FCC IDs, UPC or EAN codes, and date codes, each with a short label.",
  "confidence values are numbers from 0 to 1. quantity is a number. Use empty strings for anything missing.",
].join("\n");

const ORDER_SYSTEM = [
  "You read photos and screenshots of purchase orders: online order confirmations, order history pages, order emails, carts after checkout, and paper or web order forms from any store or supplier.",
  "Pull out who the order was placed with, the order number, the order date, and every item ordered with its quantity.",
  "Copy order numbers and part numbers exactly as shown. Never guess a number you cannot fully read: leave it empty and give it a confidence of 0.",
  "Reply with only one JSON object, no markdown fences, no commentary, in exactly this shape:",
  '{"source":"order","shipment":{"vendor":"","tracking":"","po":"","order":"","date":""},"items":[{"name":"","kind":"part|tool|consumable","part_number":"","serial":"","manufacturer":"","model":"","quantity":1,"unit":"each","other_ids":[],"confidence":{"name":0,"part_number":0,"serial":0,"quantity":0}}],"notes":""}',
  "vendor: the store or supplier the order was placed with. order: the order number. po: a purchase order number if one is shown. date: the order date as YYYY-MM-DD.",
  "items: one entry per ordered line with its quantity. name: a short plain description of the product. part_number: a model, part, or item number if shown.",
  "kind: tool for reusable tools, consumable for anything used up such as memory cards, batteries, tape, fasteners, cleaners, part for components that get installed.",
  "Leave serial empty. Prices are not needed. If nothing ordered can be identified, return an empty items array and say why in notes.",
].join("\n");

function str(v, max = 200) {
  return v === null || v === undefined ? "" : String(v).trim().slice(0, max);
}
function num01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function normalize(raw) {
  const src = ["manifest", "box", "label", "part", "order", "other"].includes(raw.source) ? raw.source : "other";
  const ship = raw.shipment && typeof raw.shipment === "object" ? raw.shipment : {};
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 60) : [];
  return {
    source: src,
    shipment: {
      vendor: str(ship.vendor),
      tracking: str(ship.tracking),
      po: str(ship.po),
      order: str(ship.order),
      date: str(ship.date, 40),
    },
    items: items.map((it) => {
      const c = it && typeof it.confidence === "object" && it.confidence ? it.confidence : {};
      const qty = Number(it.quantity);
      return {
        name: str(it.name),
        kind: ["part", "tool", "consumable"].includes(it.kind) ? it.kind : "part",
        part_number: str(it.part_number, 80),
        serial: str(it.serial, 80),
        manufacturer: str(it.manufacturer, 120),
        model: str(it.model, 120),
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unit: str(it.unit, 30) || "each",
        other_ids: (Array.isArray(it.other_ids) ? it.other_ids : [])
          .slice(0, 20)
          .map((o) => ({ label: str(o && o.label, 60), value: str(o && o.value, 120) }))
          .filter((o) => o.value),
        confidence: {
          name: num01(c.name),
          part_number: num01(c.part_number),
          serial: num01(c.serial),
          quantity: num01(c.quantity),
        },
      };
    }),
    notes: str(raw.notes, 500),
  };
}

export async function extractFromImage({ mediaType, base64, barcodes, purpose }) {
  const codes = (barcodes || []).map((b) => str(b, 200)).filter(Boolean).slice(0, 10);
  const text = codes.length
    ? "Barcode values decoded on the phone: " + codes.join(" | ")
    : "No barcodes were decoded on the phone.";
  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 4000,
      system: purpose === "order" ? ORDER_SYSTEM : SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text },
          ],
        },
      ],
    },
    { timeout: 60000, maxRetries: 1 }
  );
  const out = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`model reply had no JSON (stop reason: ${message.stop_reason})`);
  return normalize(JSON.parse(out.slice(start, end + 1)));
}
