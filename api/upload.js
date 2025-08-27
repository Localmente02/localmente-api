import { put } from '@vercel/blob';

// Funzione per creare una risposta con le intestazioni CORS corrette
function createCorsResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*', // Permette a QUALSIASI sito di chiamare questa API
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export default async function handler(request) {
  // Vercel invia una richiesta "preflight" di tipo OPTIONS per controllare i permessi CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  
  // Codice di upload originale
  if (request.method === 'POST') {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get('filename');

    if (!filename || !request.body) {
      return createCorsResponse({ message: 'Richiesta non valida.' }, 400);
    }

    try {
      const blob = await put(filename, request.body, { access: 'public' });
      return createCorsResponse(blob, 200);
    } catch (error) {
      return createCorsResponse({ message: 'Errore durante l\'upload su Vercel Blob', error: error.message }, 500);
    }
  }

  // Se non è POST o OPTIONS, restituisci un errore
  return createCorsResponse({ message: 'Metodo non consentito' }, 405);
}
