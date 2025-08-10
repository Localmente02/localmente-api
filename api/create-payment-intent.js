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
        shippingAmount, // Il nostro nuovo campo spedizione
        tipAmount       // Il nostro nuovo campo mancia
      } = req.body;

      if (!amount || !currency) {
        return res.status(400).json({ error: 'Missing amount or currency' });
      }

      const params = {
        amount: parseInt(amount),
        currency: currency,
        payment_method_types: ['card'],
        description: description || 'Ordine Localmente',
        metadata: metadata,
      };

      // Gestione di Stripe Connect
      if (stripeAccountId) {
        
        // Calcoliamo il guadagno totale del rider: Spedizione + Mancia
        const riderTotal = (parseInt(shippingAmount) || 0) + (parseInt(tipAmount) || 0);

        // Somma del Rider + Commissione (tutto ciò che non va al venditore)
        const totalDeductions = riderTotal + (parseInt(applicationFeeAmount) || 0);

        // L'importo che va effettivamente al venditore
        const destinationAmount = params.amount - totalDeductions;
        
        if (destinationAmount < 50) { // Stripe ha un minimo (es. 50 cent)
          throw new Error('L\'importo destinato al venditore è troppo basso dopo le detrazioni.');
        }

        params.transfer_data = {
          destination: stripeAccountId,
          amount: destinationAmount
        };

        // Creiamo un trasferimento separato per il rider
        // NOTA: Questo richiede che l'account del rider sia abilitato a ricevere trasferimenti.
        // Questo è uno scenario avanzato. Per ora, lo mettiamo nei metadati e lo gestiremo
        // con un webhook, una soluzione più robusta.
        // Qui ci limitiamo a preparare i dati.
        
        // Semplifichiamo per ora: i trasferimenti ai rider verranno gestiti
        // in un secondo momento tramite una Cloud Function che legge l'ordine
        // una volta che è pagato. Per adesso, la mancia è solo registrata.
        // Il calcolo di `application_fee_amount` deve essere il nostro guadagno.
        // Il venditore riceve amount - application_fee_amount.
        // Poi noi dal nostro account pagheremo i rider. Questo è un modello di business.
        
        // CAMBIO DI STRATEGIA PER SEMPLICITA' E SICUREZZA:
        // L'importo va al venditore, al netto della NOSTRA commissione.
        // LA NOSTRA commissione include: il nostro guadagno + i soldi da dare al rider.
        // Poi, separatamente, noi paghiamo i rider. Questo è il modello Payouts.
        
        const ourFee = parseInt(applicationFeeAmount) || 0; // Il nostro guadagno
        const riderEarnings = (parseInt(shippingAmount) || 0) + (parseInt(tipAmount) || 0);
        
        // La commissione totale dell'applicazione che Stripe trattiene per noi
        const totalApplicationFee = ourFee + riderEarnings;
        
        params.application_fee_amount = totalApplicationFee;
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
