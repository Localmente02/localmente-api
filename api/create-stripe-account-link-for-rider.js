// api/create-stripe-account-link-for-rider.js
// Vercel Function per gestire la creazione/aggiornamento di Stripe Connect Account Link per i Rider.
// Questo endpoint sarà chiamato dal frontend (connect_stripe.html) in modo sicuro.

// Carica Stripe SDK (chiave segreta) e Firebase Admin SDK (per interagire con Firestore sul server)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Inizializza Firebase Admin SDK solo una volta
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID // Usa il Project ID dalle variabili d'ambiente di Vercel
    });
}
const db = admin.firestore(); // Ottieni l'istanza di Firestore Admin

module.exports = async (req, res) => {
    // Solo richieste POST sono accettate
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { riderUid, riderEmail, riderLegalName, stripeAccountId, returnUrl, refreshUrl } = req.body;

        // Validazione input basilare
        if (!riderUid || !riderEmail || !riderLegalName || !returnUrl || !refreshUrl) {
            return res.status(400).json({ error: 'Missing required parameters (riderUid, riderEmail, riderLegalName, returnUrl, refreshUrl).' });
        }

        let accountIdToUse = stripeAccountId; // Usiamo l'ID fornito se già esistente

        // --- Passo 1: Crea o Recupera l'Account Stripe Express ---
        if (!accountIdToUse) {
            // Se non c'è un stripeAccountId, dobbiamo crearne uno nuovo
            console.log(`Creating new Stripe account for rider: ${riderEmail}`);
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'IT', // Assumiamo IT per i nostri rider di Civora
                email: riderEmail,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                business_profile: {
                    name: riderLegalName,
                    url: 'https://rider.civora.app', // URL pubblico dell'app rider o un placeholder
                },
                tos_acceptance: {
                    date: Math.floor(Date.now() / 1000), // Accettazione ToS alla data corrente
                    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress, // Indirizzo IP del client
                },
            });
            accountIdToUse = account.id;

            // Aggiorna Firestore con il nuovo Stripe Account ID
            const riderRef = db.collection('riders').doc(riderUid);
            await riderRef.update({
                stripeAccountId: accountIdToUse,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`New Stripe account created and saved to Firestore: ${accountIdToUse}`);
        } else {
            // Se l'ID esiste, facciamo un controllo per assicurarci che sia valido
            // O semplicemente lo usiamo per creare il link, Stripe gestirà se è incompleto
            console.log(`Using existing Stripe account: ${accountIdToUse} for rider: ${riderEmail}`);
            // Potremmo voler fare un retrieve account qui per validare, ma per ora lo saltiamo per semplicità
            // const account = await stripe.accounts.retrieve(accountIdToUse);
            // if (account.email !== riderEmail) throw new Error("Stripe account email mismatch.");
        }

        // --- Passo 2: Crea l'Account Link per l'Onboarding/Dashboard ---
        console.log(`Creating Stripe account link for account: ${accountIdToUse}`);
        const accountLink = await stripe.accountLinks.create({
            account: accountIdToUse,
            refresh_url: refreshUrl, // URL a cui Stripe reindirizza se il link scade o non viene completato
            return_url: returnUrl,   // URL a cui Stripe reindirizza dopo che l'utente completa il processo
            type: 'account_onboarding', // O 'account_update' se vogliamo solo aggiornare l'account
        });
        console.log(`Stripe account link created: ${accountLink.url}`);

        // Restituisci l'URL di Stripe al frontend insieme all'accountId (utile se è nuovo)
        res.status(200).json({ url: accountLink.url, stripeAccountId: accountIdToUse });

    } catch (error) {
        console.error("Error in create-stripe-account-link-for-rider:", error);
        res.status(500).json({ error: error.message || 'Failed to create Stripe account link.' });
    }
};
