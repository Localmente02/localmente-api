// api/create-payment-intent.js
// VERSIONE NAKED: Creazione PaymentIntent con solo il necessario,
// per aggirare l'errore "parameters_exclusive" e permettere il pagamento.
// Nessun trasferimento o fee gestiti qui. Tutti i soldi addebitati
// andranno sul conto della piattaforma Localmente.
// Lo split sarà gestito dal webhook.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const { 
        amount,           // L'importo TOTALE che il cliente paga
        currency, 
        description, 
        metadata          // I metadati dell'ordine/venditore
        // TUTTI gli altri parametri come stripeAccountId, applicationFeeAmount,
        // shippingAmount, tipAmount NON vengono usati qui per evitare conflitti.
      } = req.body;

      if (!amount || !currency) {
        return res.status(400).json({ error: 'Missing amount or currency' });
      }

      const params = {
        amount: parseInt(amount), // Importo TOTALE (prodotti + servizio + spedizione + mancia)
        currency: currency,
        payment_method_types: ['card'],
        description: description || 'Ordine Localmente',
        metadata: metadata,
        // NON AGGIUNGERE NESSUN parametro come `transfer_data` o `application_fee_amount` QUI.
        // Questi sono la causa del problema.
      };

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
