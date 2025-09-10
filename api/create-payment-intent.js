// api/create-payment-intent.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const { 
        amount, 
        currency, 
        description, 
        stripeAccountId, 
        applicationFeeAmount, 
        metadata,
        customerUserId // <<< NUOVO: L'ID dell'utente Flutter
      } = req.body; // <<< AGGIUNTO customerUserId QUI

      if (!amount || !currency || !customerUserId) { // <<< AGGIUNTO customerUserId NELLA VALIDAZIONE
        return res.status(400).json({ error: 'Missing amount, currency, or customerUserId' });
      }

      const params = {
        amount: parseInt(amount),
        currency: currency,
        payment_method_types: ['card'],
        description: description || 'No description provided',
        metadata: {
          ...metadata, // Mantieni i metadati esistenti
          customerUserId: customerUserId // <<< AGGIUNTO L'ID UTENTE AI METADATI DI STRIPE
        },
      };

      // Gestione di Stripe Connect per marketplace
      if (stripeAccountId) {
        params.transfer_data = {
          destination: stripeAccountId,
        };
        // L'application_fee_amount è la tua commissione
        if (applicationFeeAmount) {
          params.application_fee_amount = parseInt(applicationFeeAmount);
        }
      }

      const paymentIntent = await stripe.paymentIntents.create(params);

      res.status(200).json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      console.error('Error creating payment intent:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
};
