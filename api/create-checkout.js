const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Pricing constants (must match frontend exactly) ───────────────────────────
const BASE_PRICES  = { single: 30, duo: 60, family: 110 };
const MAT_COUNT    = { single: 1,  duo: 2,  family: 4   };
const BUNDLE_LABELS = {
  single: 'Single Prayer Mat',
  duo:    'Duo Set (2 Mats)',
  family: 'Family Set (4 Mats)'
};
const NAME_ADDON   = 7;
const ARABIC_ADDON = 2;  // only when name is also filled
const SYMBOL_ADDON = 2;
const TASBIH_PRICE = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSymbols(symbolStr) {
  const result = ['none', 'none', 'none', 'none'];
  if (!symbolStr) return result;
  symbolStr.split(',').forEach(part => {
    const m = part.trim().match(/^Mat(\d):(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < 4) result[idx] = m[2].trim();
    }
  });
  return result;
}

/**
 * Build Stripe line_items for a single cart item.
 * prefix is e.g. "[Order 1]" when multiple items; empty string otherwise.
 */
function buildItemLineItems(item, prefix) {
  const bundleName = item.bundleName;
  const mats       = MAT_COUNT[bundleName] || 1;
  const symbols    = parseSymbols(item.symbol || '');
  const pfx        = prefix ? prefix + ' ' : '';
  const addTasbih  = item.tasbih === 'yes';
  const result     = [];

  // Base bundle
  result.push({
    price_data: {
      currency: 'usd',
      unit_amount: BASE_PRICES[bundleName] * 100,
      product_data: {
        name: pfx + (BUNDLE_LABELS[bundleName] || 'Prayer Mat'),
        description: 'Personalised embroidered prayer mat — Sajda Studio'
      }
    },
    quantity: 1
  });

  const matNames = [item.matName1||'', item.matName2||'', item.matName3||'', item.matName4||''];
  const arabics  = [item.matArabic1, item.matArabic2, item.matArabic3, item.matArabic4];

  for (let i = 0; i < mats; i++) {
    const matLabel = mats > 1 ? ` (Mat ${i + 1})` : '';
    const name     = (matNames[i] || '').trim();

    if (name) {
      result.push({
        price_data: {
          currency: 'usd',
          unit_amount: NAME_ADDON * 100,
          product_data: {
            name: pfx + `Custom Name Embroidery${matLabel}`,
            description: `Name: "${name}"`
          }
        },
        quantity: 1
      });

      if (arabics[i]) {
        result.push({
          price_data: {
            currency: 'usd',
            unit_amount: ARABIC_ADDON * 100,
            product_data: {
              name: pfx + `Arabic Script${matLabel}`,
              description: `Arabic script for: "${name}"`
            }
          },
          quantity: 1
        });
      }
    }

    if (symbols[i] && symbols[i] !== 'none') {
      const sym = symbols[i].charAt(0).toUpperCase() + symbols[i].slice(1);
      result.push({
        price_data: {
          currency: 'usd',
          unit_amount: SYMBOL_ADDON * 100,
          product_data: {
            name: pfx + `Symbol Add-on: ${sym}${matLabel}`,
            description: `Embroidered ${sym} symbol`
          }
        },
        quantity: 1
      });
    }
  }

  if (addTasbih) {
    result.push({
      price_data: {
        currency: 'usd',
        unit_amount: TASBIH_PRICE * 100,
        product_data: {
          name: pfx + 'Colour-Matched Tasbih Add-on',
          description: 'Handcrafted tasbih matching your mat colour'
        }
      },
      quantity: 1
    });
  }

  return result;
}

function buildCartSummary(cartItems) {
  return cartItems.map((item, i) => {
    const label = BUNDLE_LABELS[item.bundleName] || item.bundleName;
    const names = [item.matName1, item.matName2, item.matName3, item.matName4]
      .filter(Boolean).join('/');
    return `[${i + 1}] ${label} ${item.color || ''}${names ? ' - ' + names : ''}`;
  }).join(' | ').substring(0, 490);
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body;

    // ── Normalise to cartItems array ─────────────────────────────────────────
    let cartItems;

    if (Array.isArray(body.cartItems) && body.cartItems.length > 0) {
      cartItems = body.cartItems;
    } else if (body.bundleName) {
      // Legacy single-item format — backward compatible
      cartItems = [{
        bundleName: body.bundleName,
        color:      body.color      || '',
        matName1:   body.matName1   || '',
        matName2:   body.matName2   || '',
        matName3:   body.matName3   || '',
        matName4:   body.matName4   || '',
        matArabic1: false,
        matArabic2: false,
        matArabic3: false,
        matArabic4: false,
        symbol:     body.symbol     || '',
        thread:     body.thread     || '',
        occasion:   body.occasion   || '',
        tasbih:     body.tasbih     || 'no'
      }];
    } else {
      return res.status(400).json({ error: 'Missing cartItems or bundleName' });
    }

    // ── Validate bundles ─────────────────────────────────────────────────────
    for (const item of cartItems) {
      if (!item.bundleName || !BASE_PRICES[item.bundleName]) {
        return res.status(400).json({ error: `Invalid bundleName: ${item.bundleName}` });
      }
    }

    // ── Build line items ─────────────────────────────────────────────────────
    const usePrefix = cartItems.length > 1;
    const lineItems = [];
    for (let i = 0; i < cartItems.length; i++) {
      const prefix = usePrefix ? `[Order ${i + 1}]` : '';
      lineItems.push(...buildItemLineItems(cartItems[i], prefix));
    }

    const serverTotal = lineItems.reduce((s, li) => s + li.price_data.unit_amount, 0);
    console.log(`[checkout] items=${cartItems.length} serverTotal=$${serverTotal / 100} lineItems=${lineItems.length}`);

    // ── Build metadata from first item + shared order fields ─────────────────
    // Webhook reads ONLY from here — do not change existing field names.
    const first     = cartItems[0];
    const arabicMats = [1, 2, 3, 4]
      .filter(n => first['matArabic' + n] && (first['matName' + n] || '').trim())
      .map(String);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: body.email,
      customer_creation: 'always',
      line_items: lineItems,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },

      metadata: {
        // ── Existing fields (unchanged) ──────────────────────────────────────
        customerName: body.customerName  || '',
        bundleName:   first.bundleName   || '',
        matName1:     first.matName1     || '',
        matName2:     first.matName2     || '',
        matName3:     first.matName3     || '',
        matName4:     first.matName4     || '',
        symbol:       first.symbol       || '',
        color:        first.color        || '',
        address:      body.address       || '',
        phone:        body.phone         || '',
        thread:       first.thread       || '',
        occasion:     first.occasion     || '',
        notes:        (body.notes || '').substring(0, 100),
        tasbih:       first.tasbih === 'yes' ? 'yes' : 'no',
        // ── New fields ───────────────────────────────────────────────────────
        arabic:       arabicMats.join(','),
        cartSummary:  buildCartSummary(cartItems),
        itemCount:    String(cartItems.length)
      },

      success_url: body.successUrl || `${req.headers.origin}/`,
      cancel_url:  body.cancelUrl  || `${req.headers.origin}/`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
