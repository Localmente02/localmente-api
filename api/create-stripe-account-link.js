 // api/create-stripe-account-link.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // <<< INIZIO MODIFICA: GESTIONE RICHIESTE OPTIONS (PER CORS PREFLIGHT) >>>
  if (req.method === 'OPTIONS') {
    // Rispondi OK alla richiesta OPTIONS, il browser poi procederà con la richiesta POST
    res.status(200).end();
    return;
  }
  // <<< FINE MODIFICA >>>

  if (req.method === 'POST') {
    try {
      const { accountId, refreshUrl, returnUrl, email, businessName } = req.body;

      if (!accountId) {
        // Se non abbiamo un accountId esistente, ne creiamo uno nuovo
        const account = await stripe.accounts.create({
          type: 'express', // Per i venditori del marketplace
          country: 'IT', // Assumiamo Italia
          email: email, // L'email del venditore
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: {
            name: businessName,
          },
        });
        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: 'account_onboarding',
        });
        return res.status(200).json({ accountId: account.id, url: accountLink.url });
      } else {
        // Se abbiamo già un accountId, creiamo solo il link per l'onboarding/aggiornamento
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: 'account_onboarding',
        });
        return res.status(200).json({ accountId: accountId, url: accountLink.url });
      }
    } catch (error) {
      console.error('Error creating Stripe account link:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
};
