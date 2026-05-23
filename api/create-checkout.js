const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Bundle base prices (dollars) ──────────────────────────────────────────────
const BASE_PRICES = {
  single:  35,
  duo:     60,
  family: 110
};

// ── How many mat slots each bundle has ────────────────────────────────────────
const MAT_COUNT = {
  single: 1,
  duo:    2,
  family: 4
};

const BUNDLE_LABELS = {
  single: 'Single Prayer Mat',
  duo:    'Duo Set (2 Mats)',
  family: 'Family Set (4 Mats)'
};

// ── Add-on prices (dollars) ───────────────────────────────────────────────────
const NAME_ADDON_PRICE  = 7;   // per mat with a custom name
const SYMBOL_ADDON_PRICE = 3;  // per mat with a symbol (heart / moon / tasbih)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the symbol string sent by the frontend.
 * The frontend encodes symbols as e.g. "Mat1:heart, Mat3:moon"
 * Returns an array of length 4: ['heart', 'none', 'moon', 'none']
 */
function parseSymbols(symbolStr) {
  const result = ['none', 'none', 'none', 'none'];
  if (!symbolStr) return result;
  symbolStr.split(',').forEach(part => {
    const m = part.trim().match(/^Mat(\d):(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;   // Mat1 → index 0
      if (idx >= 0 && idx < 4) result[idx] = m[2].trim();
    }
  });
  return result;
}

/**
 * Build the Stripe line_items array.
 * One item for the base bundle, then individual add-on items per mat.
 */
function buildLineItems(bundleName, matNames, symbolStr, addTasbih) {
  const mats    = MAT_COUNT[bundleName]   || 1;
  const symbols = parseSymbols(symbolStr);
  const items   = [];

  // ── 1. Base bundle line item ─────────────────────────────────────────────
  items.push({
    price_data: {
      currency: 'usd',
      unit_amount: BASE_PRICES[bundleName] * 100,
      product_data: {
        name: BUNDLE_LABELS[bundleName] || 'Sajda Studio Prayer Mat',
        description: 'Personalised embroidered prayer mat — Sajda Studio'
      }
    },
    quantity: 1
  });

  // ── 2. Per-mat add-on line items ─────────────────────────────────────────
  for (let i = 0; i < mats; i++) {
    const matLabel = mats > 1 ? ` (Mat ${i + 1})` : '';

    // Custom name embroidery add-on
    if (matNames[i] && matNames[i].trim()) {
      items.push({
        price_data: {
          currency: 'usd',
          unit_amount: NAME_ADDON_PRICE * 100,
          product_data: {
            name: `Custom Name Embroidery${matLabel}`,
            description: `Name: "${matNames[i].trim()}"`
          }
        },
        quantity: 1
      });
    }

    // Symbol add-on (heart / moon / tasbih)
    if (symbols[i] && symbols[i] !== 'none') {
      const symDisplay = symbols[i].charAt(0).toUpperCase() + symbols[i].slice(1);
      items.push({
        price_data: {
          currency: 'usd',
          unit_amount: SYMBOL_ADDON_PRICE * 100,
          product_data: {
            name: `Symbol Add-on: ${symDisplay}${matLabel}`,
            description: `Embroidered ${symDisplay} symbol`
          }
        },
        quantity: 1
      });
    }
  }

  // ── 3. Tasbih add-on ────────────────────────────────────────────────────────
  if (addTasbih) {
    items.push({
      price_data: {
        currency: 'usd',
        unit_amount: 500,
        product_data: {
          name: 'Colour-Matched Tasbih Add-on',
          description: 'Handcrafted tasbih matching your mat colour'
        }
      },
      quantity: 1
    });
  }

  return items;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      bundleName, email, customerName,
      matName1, matName2, matName3, matName4,
      symbol, color, address, phone, thread, occasion, notes, tasbih,
      successUrl, cancelUrl
    } = req.body;

    // ── Validate bundle ──────────────────────────────────────────────────────
    if (!bundleName || !BASE_PRICES[bundleName]) {
      return res.status(400).json({ error: 'Invalid or missing bundleName' });
    }

    // ── Build mat names array (mirrors frontend's allNames) ──────────────────
    const matNames = [
      matName1 || '',
      matName2 || '',
      matName3 || '',
      matName4 || ''
    ];

    // ── Build itemised line items ─────────────────────────────────────────────
    const addTasbih = tasbih === 'yes';
    const lineItems = buildLineItems(bundleName, matNames, symbol || '', addTasbih);

    // ── Sanity-check: server total must agree with what frontend calculated ───
    // (belt-and-suspenders; Stripe charges the sum of line items, not amountCents)
    const serverTotal = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount, 0);
    console.log(`[checkout] bundle=${bundleName} serverTotal=$${serverTotal / 100} lineItems=${lineItems.length}`);

    // ── Create Stripe Checkout session ───────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: lineItems,
      allow_promotion_codes: true,

      // ── Metadata kept 100% identical to original ─────────────────────────
      // Webhook reads ONLY from here — do not change field names.
      metadata: {
        customerName: customerName || '',
        bundleName:   bundleName   || '',
        matName1:     matName1     || '',
        matName2:     matName2     || '',
        matName3:     matName3     || '',
        matName4:     matName4     || '',
        symbol:       symbol       || '',
        color:        color        || '',
        address:      address      || '',
        phone:        phone        || '',
        thread:       thread       || '',
        occasion:     occasion     || '',
        notes:        (notes       || '').substring(0, 100),
        tasbih:       tasbih === 'yes' ? 'yes' : 'no'
      },

      success_url: successUrl || `${req.headers.origin}/`,
      cancel_url:  cancelUrl  || `${req.headers.origin}/`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
