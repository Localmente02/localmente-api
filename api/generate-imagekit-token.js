// File: /api/generate-imagekit-token.js


const admin = require('firebase-admin');
const ImageKit = require('imagekit');

if (!admin.apps.length) {

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Corregge la formattazione della chiave
    }),
  });
}
const db = admin.firestore();


module.exports = async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');


  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {

    const configDoc = await db.collection('config_private').doc('BucTmeGHsIP48iX2a561').get();
    if (!configDoc.exists) {
      throw new Error("Documento di configurazione non trovato in Firestore.");
    }
    const configData = configDoc.data();


    const imagekitPrivateKey = configData.imagekitPrivateKey;
    const imagekitPublicKey = configData.imagekitPublicKey;
    const imagekitUrlEndpoint = configData.imagekitUrlEndpoint;

    if (!imagekitPrivateKey || !imagekitPublicKey || !imagekitUrlEndpoint) {
      throw new Error("Credenziali di ImageKit mancanti nel documento di configurazione.");
    }
    

    const imagekit = new ImageKit({
      privateKey: imagekitPrivateKey,
      publicKey: imagekitPublicKey,
      urlEndpoint: imagekitUrlEndpoint,
    });


    const authenticationParameters = imagekit.getAuthenticationParameters();

    res.status(200).json(authenticationParameters);

  } catch (error) {
    console.error("Errore nella generazione del token di ImageKit:", error);
    res.status(500).json({ error: 'Impossibile generare il token di autenticazione.', details: error.message });
  }
};
