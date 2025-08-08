const https = require('https');
const { GoogleAuth } = require('google-auth-library');

async function getProducts(projectId, clientEmail, privateKey) {
  // ... (tutto il codice della funzione REST che ti ho già dato)
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: 'global_product_catalog' }],
      limit: 100
    }
  };

  const auth = new GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: 'https://www.googleapis.com/auth/datastore'
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Firestore API error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(queryBody));
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Mancano le credenziali di Firebase.");
    }

    const firestoreResponse = await getProducts(projectId, clientEmail, privateKey);
    
    const products = firestoreResponse.map(item => {
        if (!item.document) return null;
        const fields = item.document.fields;
        return {
            id: item.document.name.split('/').pop(),
            nome: fields.productName?.stringValue || '',
            prezzo: fields.price?.doubleValue || fields.price?.integerValue || 0,
            spiegazione: "Prodotto di test.",
            imageUrl: fields.imageUrls?.arrayValue?.values?.[0]?.stringValue || null,
            unit: fields.unit?.stringValue || ''
        }
    }).filter(Boolean);

    if (products.length === 0) {
        return res.status(200).json([]);
    }

    const shuffled = products.sort(() => 0.5 - Math.random());
    const randomSuggestions = shuffled.slice(0, 3);
    
    return res.status(200).json(randomSuggestions);

  } catch (error) {
    console.error('Errore API REST:', error);
    return res.status(500).json({ error: 'Errore interno.' });
  }
};
