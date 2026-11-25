# MapCidade Contract Report

Anonymized, from-scratch reconstruction of a real internal tool's architecture, built for a portfolio. Fictional data only ("MapCidade") — no real company, city, or infrastructure is represented here.

## English

### Problem

Contract analysts need a reviewable summary assembled from city usage, storage, and support systems with independent failure modes.

### Solution

Parallel adapters collect metrics under individual deadlines. A review screen exposes source failures and lets analysts edit the draft before rendering a Word document.

### Stack

TypeScript, Express, SQLite, Zod, OOXML.

### How to run

With Node.js 22.13+, run `npm install` and `npm run dev`. Run `npm test`, `npm run build` and `npm run lint` to verify the project.

### Demo

Open `http://localhost:4601`, collect a period, edit the fields, and download the report. Simulate an auxiliary outage to see the source notes. Run `npm run generate -- rivermeadow` for a terminal demo.

### What I learned

Adapters keep collection rules independent of database and network transports. The primary data source must succeed, while optional failures are recorded alongside the results. The demo generates SQLite, helpdesk, and remote disk fixtures locally.

## Português

### Problema

Analistas de contratos precisam reunir dados de uso municipal, armazenamento e suporte em um relatório que possa ser revisado.

### Solução

Adaptadores consultam as fontes em paralelo e aplicam prazos independentes. A tela de revisão sinaliza falhas e permite editar a minuta antes de exportar o documento Word.

### Stack

TypeScript, Express, SQLite, Zod, OOXML.

### Como rodar

Com Node.js 22.13+, execute `npm install` e `npm run dev`. Valide com `npm test`, `npm run build` e `npm run lint`.

### Demo

Abra `http://localhost:4601`, colete um período, edite os campos e baixe o relatório. Simule uma falha auxiliar para ver os avisos. Para gerar pelo terminal, execute `npm run generate -- rivermeadow`.

### O que aprendi

Os adaptadores isolam as regras de coleta dos protocolos de banco e rede. A fonte principal precisa responder, e as falhas opcionais são registradas junto dos resultados. O demo gera localmente dados de SQLite, suporte e discos remotos.
