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

        const scrapeSingleUrl = async (fetchUrl) => {
          try {
            const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
              method: "POST",
              headers,
              body: JSON.stringify({
                url: fetchUrl,
                country: "us",
                useBrowser: true,
                formats: ["markdown", "html"]
              })
            });

            if (!submitRes.ok) return "";
            const jobData = await submitRes.json();
            const jobId = jobData.jobId || jobData.id;
            if (!jobId) return "";

            let attempts = 0;
            while (attempts < 20) {
              await new Promise(r => setTimeout(r, 1000));
              attempts++;

              const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
              if (pollRes.ok) {
                const result = await pollRes.json();
                if (result.status === "completed") {
                  return result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
                } else if (result.status === "failed") {
                  break;
                }
              }
            }
            return "";
          } catch (e) {
            return "";
          }
        };

        // 1. Raspa a página principal do evento informado na requisição
        const mainContent = await scrapeSingleUrl(targetURL);

        if (!mainContent) {
          throw new Error("Não foi possível obter os dados da WSL no Anakin.");
        }

        // 2. Extrai automaticamente todos os roundIds presentes no conteúdo raspado
        const roundMatches = [...mainContent.matchAll(/roundId=(\d+)/g)];
        const discoveredRoundIds = [...new Set(roundMatches.map(m => m[1]))];

        let extraContents = [];
        if (discoveredRoundIds.length > 0) {
          const baseUrl = targetURL.split('?')[0];
          
          // Cria URLs secundárias apenas para roundIds que ainda não estão na URL original
          const extraUrls = discoveredRoundIds
            .map(rid => `${baseUrl}?roundId=${rid}`)
            .filter(u => u !== targetURL);

          // Limita a no máximo 3 requisições paralelas para evitar estouro de tempo limite
          const urlsToFetch = extraUrls.slice(0, 3);
          extraContents = await Promise.all(urlsToFetch.map(u => scrapeSingleUrl(u)));
        }

        // 3. Consolida todo o texto raspado
        const fullContent = [mainContent, ...extraContents].join("\n").trim();

        // 4. Limpeza e extração por padrão de notas
        const cleanContent = fullContent
          .replace(/&nbsp;/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '\n')
          .replace(/Make heat picks|\*Fan picks|Details|Replay|Watch [^\n]+/gi, '')
          .replace(/\r\n|\r/g, '\n');

        const lines = cleanContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) > 0;
        
        const isBadName = (s) => {
          if (!s || s.length < 2 || s.length > 35 || /\d/.test(s)) return true;
          const bad = ['heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal', 'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply', 'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro', 'event', 'product', 'attribute', 'value', 'description', 'image', 'tourism', 'airways', 'resort', 'island', 'surf', 'surfline', 'corona', 'cero'];
          const l = s.toLowerCase();
          return bad.some(b => l.includes(b));
        };

        const heatsFound = [];

        for (let i = 0; i < lines.length; i++) {
          if (isScore(lines[i])) {
            let p1 = null;
            for (let b = 1; b <= 5 && (i - b) >= 0; b++) {
              if (!isBadName(lines[i - b])) {
                p1 = lines[i - b];
                break;
              }
            }

            for (let f = 1; f <= 8 && (i + f) < lines.length; f++) {
              if (isScore(lines[i + f])) {
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
                  i = i + f;
                  break;
                }
              }
            }
          }
        }

        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          const kReverse = `${h.p2}-${h.p1}`;
          if (!keys.has(k) && !keys.has(kReverse)) { 
            keys.add(k); 
            unicos.push(h); 
          }
        });

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