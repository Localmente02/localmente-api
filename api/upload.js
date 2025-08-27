import { put } from '@vercel/blob';

// QUESTA È LA RIGA MAGICA CHE RISOLVE IL PROBLEMA
export const config = {
  api: {
    bodyParser: false, // Dice a Vercel di non "interpretare" il corpo della richiesta
  },
};

export default async function handler(req, res) {
  // Gestione della richiesta preliminare OPTIONS per CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  
  // Imposta le intestazioni CORS per la risposta POST
  res.setHeader('Access-control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Metodo non consentito.' });
    return;
  }

  const filename = req.query.filename;
  if (!filename) {
    res.status(400).json({ message: 'Nome del file non trovato.' });
    return;
  }
  
  try {
    // Ora 'req' (la richiesta stessa) è il flusso di dati dell'immagine
    // Lo passiamo direttamente a Vercel Blob
    const blob = await put(filename, req, {
      access: 'public',
      // Aggiungiamo il content-type per aiutare Vercel
      contentType: req.headers.get('content-type') || 'application/octet-stream',
    });

    res.status(200).json(blob);
    
  } catch (error) {
    console.error('Errore durante l\'upload su Vercel Blob:', error);
    res.status(500).json({ message: 'Errore durante l\'upload su Vercel Blob', error: error.message });
  }
}
