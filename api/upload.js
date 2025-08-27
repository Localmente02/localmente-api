import { put } from '@vercel/blob';

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
  
  // Controlla che il metodo sia POST
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Metodo non consentito. Solo POST è accettato.' });
    return;
  }

  const filename = req.query.filename;

  if (!filename) {
    res.status(400).json({ message: 'Nome del file non trovato nei parametri URL.' });
    return;
  }
  
  try {
    // Il corpo della richiesta (l'immagine) viene passato direttamente a 'put'
    const blob = await put(filename, req.body, {
      access: 'public',
    });

    // Invia la risposta con successo
    res.status(200).json(blob);
    
  } catch (error) {
    console.error('Errore durante l\'upload su Vercel Blob:', error);
    res.status(500).json({ message: 'Errore durante l\'upload su Vercel Blob', error: error.message });
  }
}
