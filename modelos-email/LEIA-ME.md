# Modelos de e-mail da aula (Brevo)

Quatro lembretes transacionais enviados pelo assistente antes da aula. Os textos aqui são genéricos: a cada turma o conteúdo é editado direto no Brevo, e os números dos modelos continuam os mesmos.

Parâmetros disponíveis: `{{ params.NOME }}`, `{{ params.DATA_AULA }}` e `{{ params.LINK_AULA }}` (vem de `AULA_LINK`).

| Arquivo | Quando sai | Variável com o número do modelo |
|---|---|---|
| `1-faltam-3-dias.html` | 3 dias antes | `BREVO_MODELO_AULA_3DIAS` |
| `2-falta-1-dia.html` | véspera | `BREVO_MODELO_AULA_AMANHA` |
| `3-falta-1-hora.html` | 1 hora antes | `BREVO_MODELO_AULA_1HORA` |
| `4-estamos-ao-vivo.html` | na hora | `BREVO_MODELO_AULA_AOVIVO` |

No Brevo: Modelos > Novo modelo > "Cole seu código" (HTML), cole o arquivo, preencha assunto e remetente e ative.
