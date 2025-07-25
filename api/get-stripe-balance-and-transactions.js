// api/get-stripe-balance-and-transactions.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // Gestione delle richieste OPTIONS per CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') { // Questa funzione usa il metodo GET
    try {
      const { stripeAccountId } = req.query; // I parametri GET sono in req.query

      if (!stripeAccountId) {
        return res.status(400).json({ error: 'Missing Stripe Account ID' });
      }

      // Recupera il saldo
      const balance = await stripe.balance.retrieve({
        stripeAccount: stripeAccountId,
      });

      // Recupera le transazioni (es. le ultime 20)
      const transactions = await stripe.balanceTransactions.list({
        limit: 20,
        expand: ['data.source'], // Espande i dettagli della fonte (charge, transfer, ecc.)
      }, {
        stripeAccount: stripeAccountId,
      });

      res.status(200).json({
        balance: balance,
        transactions: transactions.data,
      });

    } catch (error) {
      console.error('Error fetching Stripe balance and transactions:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'GET, OPTIONS'); // Questa funzione accetta GET e OPTIONS
    res.status(405).end('Method Not Allowed');
  }
};
