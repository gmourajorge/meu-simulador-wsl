export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url') || 'https://www.worldsurfleague.com/events/2026/ct/442/fiji-pro/results';

      if (!targetURL.endsWith('/results') && !targetURL.includes('/results?')) {
        targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      }

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Content-Type': 'application/json'
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const headers = {
          "X-API-Key": env.ANAKIN_API_KEY,
          "Content-Type": "application/json"
        };

        const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: targetURL,
            country: "us",
            useBrowser: true,
            formats: ["markdown", "html"]
          })
        });

        if (!submitRes.ok) {
          throw new Error(`Erro no servidor Anakin: Status ${submitRes.status}`);
        }

        const jobData = await submitRes.json();
        const jobId = jobData.jobId || jobData.id;

        if (!jobId) {
          throw new Error("Não foi possível obter o ID da tarefa no Anakin.");
        }

        let content = "";
        let attempts = 0;
        while (attempts < 20) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;

          const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
          if (pollRes.ok) {
            const result = await pollRes.json();
            if (result.status === "completed") {
              content = result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
              break;
            } else if (result.status === "failed") {
              throw new Error("A raspagem falhou no servidor do Anakin.");
            }
          }
        }

        if (!content) {
          throw new Error("Tempo limite excedido para obter a resposta.");
        }

        // 1. Normalização profunda de caracteres e quebras
        const cleanContent = content
          .replace(/&nbsp;/g, ' ')
          .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '\n')
          .replace(/\r\n|\r/g, '\n');

        const lines = cleanContent
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        // 2. Funções de validação de elementos
        const isScore = (s) => /^\d{1,2}\.\d{1,2}$/.test(s) && parseFloat(s) <= 20.0;
        const isBadName = (s) => {
          if (!s || s.length < 2 || s.length > 35 || /\d/.test(s)) return true;
          const bad = ['heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal', 'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply', 'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro'];
          const l = s.toLowerCase();
          return bad.some(b => l.includes(b));
        };

        // 3. Algoritmo de Varredura Relativa
        const heatsFound = [];

        for (let i = 0; i < lines.length; i++) {
          if (isScore(lines[i])) {
            // Busca o Nome 1 voltando até 3 linhas
            let p1 = null;
            for (let b = 1; b <= 3 && (i - b) >= 0; b++) {
              if (!isBadName(lines[i - b])) {
                p1 = lines[i - b];
                break;
              }
            }

            // Busca a segunda Nota em até 4 linhas à frente
            for (let f = 1; f <= 4 && (i + f) < lines.length; f++) {
              if (isScore(lines[i + f])) {
                // Busca o Nome 2 no intervalo entre as duas notas
                let p2 = null;
                for (let k = i + 1; k < i + f; k++) {
                  if (!isBadName(lines[k])) {
                    p2 = lines[k];
                    break;
                  }
                }

                if (p1 && p2 && p1 !== p2) {
                  const score1 = parseFloat(lines[i]);
                  const score2 = parseFloat(lines[i + f]);
                  let winner = null;
                  if (score1 > score2) winner = p1;
                  else if (score2 > score1) winner = p2;

                  heatsFound.push({ p1, p2, score1, score2, winner });
                  i = i + f; // Avança o ponteiro principal
                  break;
                }
              }
            }
          }
        }

        // 4. Consolidação de baterias únicas
        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          if (!keys.has(k)) { keys.add(k); unicos.push(h); }
        });

        if (unicos.length === 0) {
          return new Response(JSON.stringify({
            sucesso: false,
            mensagem: "Página carregada via Anakin, mas o padrão das baterias não foi identificado.",
            debugLines: lines.slice(0, 50) // Retorna amostra bruta caso falhe
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          sucesso: true,
          quantidade: unicos.length,
          baterias: unicos
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ 
          sucesso: false, 
          mensagem: "Falha na extração: " + err.message 
        }), { headers: corsHeaders });
      }
    }

    return env.ASSETS.fetch(request);
  }
};