# TeleDrive — teste de vídeo Cloudflare Worker → Telegram MTProto

**Status: código criado, testes locais de cálculo aprovados; não publicado na Cloudflare e NÃO verificado com bot/Telegram real.**

Este piloto não consulta os endpoints `/video/` da VPS. O HTML de teste pode ficar na VPS, mas os bytes do vídeo são solicitados exclusivamente ao Worker, que tenta usar GramJS para consultar o Telegram via MTProto. O vídeo do exemplo tem **2 mensagens**: 536.870.912 bytes e 502.802.133 bytes, totalizando 1.039.673.045 bytes. Essas informações vêm apenas do catálogo TeleDrive, **não são garantia de acesso pelo bot**.

## Arquivos

- `src/index.js`: Cloudflare Worker + Durable Object + autenticação MTProto + `GET/HEAD /v/{VIDEO_ACCESS_KEY}.mp4`; lida com múltiplas mensagens Telegram e suporte a `206/416`.
- `src/range.mjs`: interpretação de HTTP Range e concatenação virtual das partes.
- `manifesto-exemplo.json`: **exemplo**, atualizar accessHash válido do canal antes de usá-lo como Secret. O arquivo NÃO contém credenciais do bot.
- `wrangler.toml`: configuração de Worker e migração DO com SQLite. Não é `.php` e não se executa na VPS.
- `package.json`: dependências, scripts de teste e publicação.
- `testes/`: testes unitários locais de Range.

## Publicação no painel Cloudflare (navegador + GitHub, sem SSH na VPS)

1. Crie um repositório **privado** no GitHub, colocando nele todos os arquivos do ZIP, exceto dados privados ou segredos. Não substitua o Worker `testinho.mafiafilmes.workers.dev` de outro projeto.
2. Cloudflare → Workers & Pages → Create → Import from Git → escolha o repositório. Use **Build command** `npm install && npm test`, **Deploy command** `npx wrangler deploy` (pode variar conforme o fluxo do painel). O `wrangler.toml` define o nome do novo Worker.
3. Em Settings → Variables and Secrets do Worker, cadastre **todos como Secret**:
   - `TG_API_ID` — API ID da aplicação MTProto.
   - `TG_API_HASH` — API Hash da aplicação MTProto.
   - `TG_BOT_TOKEN` — token exclusivo do bot autorizado a ler o canal.
   - `TG_VIDEO_MANIFEST_JSON` — JSON completo do manifesto, **sem placeholders**.
   - `VIDEO_ACCESS_KEY` — string aleatória com 32–128 caracteres `[A-Za-z0-9_-]`. Ela compõe a URL de vídeo; trate-a como chave pública de acesso restrito, NÃO como segredo Telegram.
   - `TEST_ACCESS_KEY` — outra string aleatória (mínimo 32 caracteres) para `/probe` e `/bytes`, enviada apenas por header `X-Test-Key`.
4. Garanta que o bot de teste seja membro do canal e possa ler **essas mensagens**, inclusive as antigas. Se as partes estão num canal privado com ID `-100...`, precisa obter **access_hash do canal via MTProto autorizado**; ele NÃO é o hash da aplicação nem token BotFather. Caso não seja possível, use um canal de teste acessível ao bot por `@username` e edite o campo `channel` no manifesto para esse username.
5. Atenção: o Worker usa o **Bot Token** para a sessão MTProto. Se o mesmo bot tiver uma sessão anterior incompatível armazenada no Durable Object, será necessário um procedimento de rotação de sessão (não apague automaticamente).
6. Após publicar, teste `https://SEU-WORKER.workers.dev/health`. A página de teste do TeleDrive fica em `https://dev.lupaconsultas.com/teste-teste/`. Informe a URL base do Worker e `VIDEO_ACCESS_KEY` nessa página, e clique em **Assistir pelo Worker**.
7. Em caso de falha, o endpoint `/probe` requer `X-Test-Key` e verifica autenticação e metadados de **todas as partes**; consulte logs do Worker, sem copiar segredos. `/bytes` testa uma leitura de 64 KiB de um MP4 virtual.

## HTTP

- `GET /health`: confere apenas Worker online.
- `GET /probe`: header `X-Test-Key`, consulta todas as mensagens MTProto sem transmitir os documentos.
- `GET /bytes`: header `X-Test-Key` e opcional `Range: bytes=0-65535`, retorna bytes do vídeo concatenado.
- `GET/HEAD /v/<VIDEO_ACCESS_KEY>.mp4`: vídeo HTML5 público apenas para quem possui a URL. `Range` recebe `206`, com teto de **512 KiB por resposta**; `HEAD` sem Range declara tamanho total; `GET` sem Range tenta fluxo completo `200` sem guardar o MP4 na memória. Um cliente que não requeira os próximos intervalos pode não reproduzir corretamente nesse piloto.
- Requisições inválidas recebem `416` com `Content-Range: bytes */TAMANHO`.

## Restrições e limitações reais

- **Não garantimos que GramJS funcione empacotado no runtime Cloudflare**; não foi executado com credenciais reais. A compatibilidade `nodejs_compat` não prova que todas as operações MTProto, especialmente TCP, criptografia e sessões persistentes, funcionarão. A biblioteca `telegram@2.26.8` é legado/experimental.
- Cada leitura MTProto tem granularidade de 512 KiB neste teste. O Durable Object mantém sessão de bot em seu armazenamento privado. Não coloque tokens no HTML, no repositório nem no manifesto.
- Não há cache de vídeo neste piloto, limitação de concorrência efetiva, busca automatizada de novos arquivos ou balanceamento de bots. Uma carga grande pode consumir CPU, duração de DO e limites Telegram.
- Existem casos de CDN redirect, FILE_REFERENCE_EXPIRED, migração de data center e FLOOD_WAIT que exigem tratamento extra para produção.
- O `VIDEO_ACCESS_KEY` é um bearer token no caminho do vídeo, visível a quem reproduz e potencialmente em logs da Cloudflare. Use exclusivamente para teste com conteúdo autorizado; não trate o link como mecanismo DRM.
- Teste inicialmente com vídeo de teste autorizado. O arquivo exemplo de duas partes do catálogo foi enviado por conta pessoal; o bot pode não conseguir consultar as mensagens. **Nunca alterar acessos ao canal de produção sem autorização.**
- Arquivos existentes de 512 MiB e o streaming PHP atual **não foram alterados**. Este código não envia, reenvia nem exclui mensagens Telegram.

## Notas de segurança

O `VIDEO_ACCESS_KEY`, mesmo extenso, não substitui autenticação de espectadores ou rate limits. O acesso ao vídeo ficará disponível para quem souber a URL de teste. Não use credenciais reais numa conta Cloudflare compartilhada sem avaliar os acessos. Separe os secrets do TeleDrive de produção.

## Fontes de referência

- https://core.telegram.org/api/files
- https://core.telegram.org/method/upload.getFile
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/
- https://developers.cloudflare.com/durable-objects/platform/limits/
