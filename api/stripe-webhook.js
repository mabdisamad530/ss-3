const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const airtableToken = process.env.AIRTABLE_TOKEN;
  const airtableBaseId = process.env.AIRTABLE_BASE_ID;

  // Log env var presence for debugging
  console.log('ENV CHECK - webhook secret present:', !!webhookSecret);
  console.log('ENV CHECK - airtable token present:', !!airtableToken);
  console.log('ENV CHECK - airtable token prefix:', airtableToken ? airtableToken.substring(0, 6) : 'MISSING');
  console.log('ENV CHECK - base id present:', !!airtableBaseId);

  let rawBody = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', resolve);
    req.on('error', reject);
  });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};

    const fields = {
      'Order Ref':        session.id,
      'Customer Name':    meta.customerName || '',
      'Email':            session.customer_email || '',
      'Amount Paid':      parseFloat((session.amount_total / 100).toFixed(2)),
      'Currency':         (session.currency || 'usd').toUpperCase(),
      'Mat Name 1':       meta.matName1 || '',
      'Mat Name 2':       meta.matName2 || '',
      'Mat Name 3':       meta.matName3 || '',
      'Mat Name 4':       meta.matName4 || '',
      'Symbol':           meta.symbol || '',
      'Color':            meta.color || '',
      'Shipping Address': meta.address || '',
      'Phone':            meta.phone || '',
      'Thread Color':     meta.thread || '',
      'Occasion':         meta.occasion || '',
      'Notes':            meta.notes || '',
      'Tasbih':           meta.tasbih === 'yes' ? 'Yes' : 'No',
      'Payment Status':   session.payment_status || '',
      'Stripe Session':   session.id,
      'Created At':       new Date().toISOString()
    };

    const url = `https://api.airtable.com/v0/${airtableBaseId}/Orders`;
    console.log('Posting to Airtable URL:', url);

    const airtableRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${airtableToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });

    const responseText = await airtableRes.text();
    console.log('Airtable response status:', airtableRes.status);
    console.log('Airtable response body:', responseText);

    if (!airtableRes.ok) {
      return res.status(500).send('Airtable write failed');
    }

    console.log('Order logged successfully:', fields['Order Ref']);
  }

  return res.status(200).json({ received: true });
};
