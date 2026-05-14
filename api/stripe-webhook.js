// /api/stripe-webhook.js — Receive Stripe webhooks
// POST from Stripe → adds customer email to Supabase when payment succeeds
//
// IMPORTANT: This endpoint disables body parsing because Stripe requires
// the RAW request body to verify the signature.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false,  // need raw body for Stripe signature verification
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to read raw body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    // Handle successful payment events
    if (event.type === 'checkout.session.completed' ||
        event.type === 'payment_intent.succeeded' ||
        event.type === 'invoice.payment_succeeded') {

      let email = null;

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        email = session.customer_email || session.customer_details?.email;
      } else if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        email = intent.receipt_email;
        if (!email && intent.customer) {
          const customer = await stripe.customers.retrieve(intent.customer);
          email = customer.email;
        }
      } else if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        email = invoice.customer_email;
      }

      if (!email) {
        console.warn('No email found in event:', event.id);
        return res.status(200).json({ received: true, warning: 'no email' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Upsert customer (insert if new, update if exists)
      const { error } = await supabase
        .from('customers')
        .upsert({
          email: normalizedEmail,
          active: true,
          stripe_event_id: event.id,
          last_payment_at: new Date().toISOString()
        }, { onConflict: 'email' });

      if (error) {
        console.error('Supabase upsert error:', error);
        return res.status(500).json({ error: 'DB error' });
      }

      console.log('Customer added/updated:', normalizedEmail);
    }

    // Handle refunds → deactivate customer
    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const email = charge.billing_details?.email || charge.receipt_email;
      if (email) {
        await supabase
          .from('customers')
          .update({ active: false, deactivated_at: new Date().toISOString() })
          .eq('email', email.trim().toLowerCase());
        console.log('Customer deactivated (refund):', email);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
