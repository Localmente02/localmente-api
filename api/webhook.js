// api/create-payment-intent.js
// RIPARATO: Versione temporanea per risolvere l'errore "parameters_exclusive".
// Tutti gli importi (prodotti, spedizione, mancia, servizio) vengono addebitati
// sull'account della piattaforma (Localmente). I trasferimenti a venditori/rider
// verranno gestiti dal webhook (prossimo step).

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const { 
        amount,           // Questo sarà l'importo TOTALE (prodotti + servizio + spedizione + mancia)
        currency, 
        description, 
        stripeAccountId,  // L'ID Stripe del venditore, non lo useremo per i trasferimenti QUI.
        applicationFeeAmount, // La nostra commissione di servizio.
        metadata,
        shippingAmount,   // Non useremo questo QUI per i trasferimenti.
        tipAmount         // Non useremo questo QUI per i trasferimenti.
      } = req.body;

      if (!amount || !currency) {
        return res.status(400).json({ error: 'Missing amount or currency' });
      }

      const params = {
        amount: parseInt(amount), // Importo TOTALE che il cliente paga (in centesimi)
        currency: currency,
        payment_method_types: ['card'],
        description: description || 'Ordine Localmente',
        metadata: metadata,
      };

      // In questo modello temporaneo, addebitiamo l'intero importo
      // sul nostro account Localmente.
      //
      // Le fees (applicationFeeAmount) che ci vengono inviate dall'app sono
      // la nostra commissione di servizio.
      //
      // I soldi di spedizione e mancia (shippingAmount e tipAmount)
      // sono INCLUSI nell'amount totale e saranno anche loro sul nostro conto.
      //
      // Tutto lo split (soldi a venditore, soldi a rider) sarà gestito in un
      // SECONDO momento, dal webhook, una volta che il PaymentIntent
      // è andato a buon fine.
      
      // La nostra commissione (solo la nostra percentuale, non mancia/spedizione)
      // Stripe trattiene questo dal totale prima di accreditarci il netto.
      if (applicationFeeAmount) {
         params.application_fee_amount = parseInt(applicationFeeAmount);
      }
      
      // Rimuovo ogni riferimento a `transfer_data` che causava l'errore
      // perché ora vogliamo che Stripe addebiti il totale solo a noi.
      // Il venditore verrà pagato successivamente dal webhook.

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
