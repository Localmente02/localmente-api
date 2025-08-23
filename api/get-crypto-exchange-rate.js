// api/get-crypto-exchange-rate.js (Nuova Vercel Function)

const fetch = require('node-fetch'); // Assicurati di avere node-fetch installato in Vercel se non lo hai già

// Mappa dei codici valuta agli ID di CoinGecko
const COINGECKO_IDS = {
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'USDC': 'usd-coin'
    // Aggiungi qui altre criptovalute se le supporti, es:
    // 'LTC': 'litecoin'
};


module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { currencyCode } = req.query; // Riceve il codice della criptovaluta (es. BTC, ETH, USDC)

  if (!currencyCode) {
    return res.status(400).json({ error: 'Missing currencyCode parameter.' });
  }
  
  // Ottieni l'ID di CoinGecko corrispondente al codice della valuta
  const coingeckoId = COINGECKO_IDS[currencyCode.toUpperCase()];
  
  if (!coingeckoId) {
    return res.status(404).json({ error: `Currency code '${currencyCode}' not supported by this API.` });
  }

  try {
    // API di CoinGecko per ottenere il tasso di cambio live
    // EUR è la valuta fiat, currencyCode è la criptovaluta
    const coingeckoApiUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=eur`;

    const response = await fetch(coingeckoApiUrl);
    const data = await response.json();

    // Esempio di risposta: {"bitcoin":{"eur":28000}}
    const cryptoData = data[coingeckoId];

    if (cryptoData && cryptoData.eur) {
      // Il tasso restituito da CoinGecko è 1 unità di cripto = X EUR.
      // A noi serve il tasso di 1 EUR = X unità crypto (per calcolare quanto crypto per 1 EUR)
      const rateEurPerCrypto = cryptoData.eur; // es. 1 BTC = 28000 EUR
      const rateCryptoPerEur = 1 / rateEurPerCrypto; // es. 1 EUR = 0.0000357 BTC

      return res.status(200).json({ 
        currencyCode: currencyCode, 
        fiatCurrency: 'EUR', 
        rate: rateCryptoPerEur // Tasso di 1 EUR in crypto
      });
    } else {
      return res.status(404).json({ error: `Exchange rate not found for ${currencyCode} to EUR.` });
    }

  } catch (error) {
    console.error('Error fetching crypto exchange rate:', error);
    return res.status(500).json({ error: 'Failed to fetch crypto exchange rate.', details: error.message });
  }
};
