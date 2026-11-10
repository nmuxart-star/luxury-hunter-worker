import http from 'node:http';

export async function resolverDesafioEnNube(payloadTask) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) {
    console.log('[Capsolver] No hay clave configurada en los secretos.');
    return null;
  }

  const datosPeticion = JSON.stringify({
    clientKey: apiKey,
    task: payloadTask
  });

  return new Promise((resolve, reject) => {
    const opciones = {
      hostname: '://capsolver.com',
      port: 443,
      path: '/createTask',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(datosPeticion)
      }
    };

    const req = http.request(opciones, (res) => {
      let cuerpo = '';
      res.on('data', (chunk) => cuerpo += chunk);
      res.on('end', () => {
        try {
          const resultado = JSON.parse(cuerpo);
          if (resultado.errorId === 0) {
            resolve(resultado.solution);
          } else {
            console.error('[Capsolver Error]', resultado.errorDescription);
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(datosPeticion);
    req.end();
  });
}
