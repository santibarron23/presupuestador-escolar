// Reglas comerciales de Librería Lerma. Se editan acá sin tocar el motor.
//
// El motor primero encuentra productos COMPATIBLES (mismo concepto del lexicón, sin atributos en
// conflicto). Estas reglas sólo deciden ENTRE productos compatibles; nunca pueden forzar un producto de
// otra categoría. Si el producto preferido no existe o no tiene stock, el motor sigue con el ranking.
//
// Regla:
//   id         nombre para logs y tests
//   concept    concepto del lexicón al que aplica (obligatorio)
//   when       condiciones opcionales sobre el pedido:
//                match / notMatch: regex sobre el texto normalizado del pedido
//                attrs: { formato: "oficio", acabado: "glitter", … } valores exigidos (null = no especificado)
//   prefer     productos preferidos en orden: { sku, name? } (name = regex sobre el nombre normalizado,
//              para desambiguar SKUs repetidos). El primero disponible gana.
//   boost      patrones sobre el nombre del producto que suman puntos (preferencia blanda)
//   exclude    patrones sobre el nombre del producto que lo descartan para este pedido
//   inStore    en vez de un producto online, informar que se consigue en sucursal ({ label, note })
//   priority   desempate entre reglas que aplican al mismo pedido (mayor gana). Default 0.

const RULES = [
  // ── Escritura ──────────────────────────────────────────────────────
  { id: "birome-gruesa", concept: "boligrafo", priority: 2, when: { attrs: { punta: "gruesa" } }, prefer: [{ sku: "010018" }] },
  { id: "birome-generica", concept: "boligrafo", when: { notMatch: /parker|pluma|gel|retractil/ }, prefer: [{ sku: "010020" }] },
  { id: "lapiz-negro", concept: "lapiz_grafito", when: { notMatch: /jumbo|triangular|2b|4b|6b|dibujo|c ?\/? ?goma/ }, prefer: [{ sku: "10442" }] },
  { id: "minas-05", concept: "minas", when: { attrs: { mina: "0.5" } }, prefer: [{ sku: "12895" }] },
  { id: "corrector", concept: "corrector", when: { notMatch: /cinta/ }, prefer: [{ sku: "140060" }] },
  { id: "goma-borrar", concept: "goma_borrar", when: { notMatch: /tinta|miga|moldeable|tecnica/ }, prefer: [{ sku: "110001" }] },
  { id: "sacapuntas", concept: "sacapuntas", when: { notMatch: /deposito|electric/ }, prefer: [{ sku: "330003" }, { sku: "330169" }] },
  { id: "resaltador", concept: "resaltador", prefer: [{ sku: "010173" }] },
  // No hay pluma escolar económica online (sólo Parker): la Writech es la opción razonable. Ver docs/AUDITORIA.md (catálogo).
  { id: "pluma-escolar", concept: "pluma", when: { notMatch: /parker/ }, prefer: [{ sku: null, name: /writech.*fountain/ }] },

  // ── Adhesivos ─────────────────────────────────────────────────────
  // Prioridad alta: en "plasticola o voligoma" gana la voligoma (criterio histórico de la librería).
  { id: "voligoma", concept: "voligoma", priority: 5, prefer: [{ sku: "050019" }] },
  { id: "plasticola-glitter", concept: "plasticola", priority: 2, when: { attrs: { acabado: "glitter" } },
    prefer: [{ sku: null, name: /adhesivo con glitter pelikan/ }, { sku: null, name: /adhesivo sta con glitter/ }] },
  { id: "plasticola-color", concept: "plasticola", priority: 1, when: { match: /\bcolou?r(es)?\b/ }, prefer: [{ sku: "50082" }] },
  { id: "plasticola", concept: "plasticola", prefer: [{ sku: "50156" }] },
  { id: "silicona-barra", concept: "silicona_barra", prefer: [{ sku: "50018" }] },
  { id: "silicona-liquida", concept: "silicona_liquida", prefer: [{ sku: "50191" }] },
  { id: "cinta-papel", concept: "cinta_papel", prefer: [{ sku: "300039" }] },
  { id: "cinta-adhesiva", concept: "cinta_adhesiva", when: { match: /embalar|ancha|48|scotch|marron|transparente/ }, prefer: [{ sku: "300045" }] },
  { id: "ojalillos", concept: "ojalillos", prefer: [{ sku: "170142" }] },
  { id: "perforadora-maped", concept: "perforadora", when: { match: /maped/ }, prefer: [{ sku: "101350" }] },

  // ── Papeles ───────────────────────────────────────────────────────
  { id: "folios-oficio", concept: "folio", priority: 1, when: { attrs: { formato: "oficio" } }, prefer: [{ sku: "150016" }] },
  { id: "folios-a4", concept: "folio", prefer: [{ sku: "150041" }] },
  // Las resmas blancas no se venden online: se informan como "solo en sucursal" (comportamiento previo).
  { id: "resma-color-oficio", concept: "hojas_a4", priority: 3, when: { attrs: { formato: "oficio" }, match: /colou?r/ }, prefer: [{ sku: "080123" }] },
  { id: "resma-color", concept: "hojas_a4", priority: 2, when: { match: /colou?r/ }, prefer: [{ sku: "080122" }] },
  { id: "resma-oficio-blanca", concept: "hojas_a4", priority: 1, when: { attrs: { formato: "oficio" } },
    inStore: { label: "Resma oficio blanca", note: "Las resmas blancas se venden sólo en sucursal." } },
  { id: "resma-a4-blanca", concept: "hojas_a4",
    inStore: { label: "Resma A4 blanca", note: "Las resmas blancas se venden sólo en sucursal. Con una resma alcanza para los pedidos de hojas sueltas." } },
  { id: "glase-fluo", concept: "papel_glase", priority: 1, when: { attrs: { acabado: "fluo" } }, prefer: [{ sku: "310074" }] },
  { id: "glase-metalizado", concept: "papel_glase", priority: 1, when: { attrs: { acabado: "metalizado" } }, prefer: [{ sku: "310003" }] },
  { id: "glase-lustre", concept: "papel_glase", prefer: [{ sku: "310002" }] },
  { id: "cartulina-metalizada", concept: "cartulina", priority: 1, when: { attrs: { acabado: "metalizado" } }, prefer: [{ sku: null, name: /cartulina metalizada/ }] },
  { id: "cartulina", concept: "cartulina", prefer: [{ sku: "30001" }] },
  { id: "afiche", concept: "afiche", prefer: [{ sku: "160009" }] },
  { id: "papel-madera", concept: "papel_madera", prefer: [{ sku: "160118" }] },
  { id: "papel-seda", concept: "papel_seda", prefer: [{ sku: "160010" }] },
  { id: "papel-crepe", concept: "papel_crepe", when: { notMatch: /perlad|fluo|fantasia/ }, prefer: [{ sku: "290001" }] },
  { id: "calcar-n5", concept: "papel_calcar", priority: 1, when: { attrs: { formato: "n5" } }, prefer: [{ sku: "020090" }, { sku: "20104" }] },
  { id: "calcar", concept: "papel_calcar", prefer: [{ sku: "020103" }] },
  { id: "block-afiche", concept: "block_afiche", prefer: [{ sku: "120277" }] },
  { id: "block-cartulina", concept: "block_cartulina", prefer: [{ sku: "120238" }] },
  { id: "block-color-n5", concept: "block_dibujo", when: { attrs: { formato: "n5", acabado: "color" } }, prefer: [{ sku: "120003" }] },

  // ── Cuadernos y carpetas ──────────────────────────────────────────
  { id: "comunicaciones", concept: "cuaderno_comunicaciones", prefer: [{ sku: "040084" }] },
  // Cuaderno ABC / A4 tapa dura rayado: Rivadavia (Oxford queda excluido salvo que lo pidan, ver EXCLUDE_UNLESS_REQUESTED).
  { id: "cuaderno-abc-60", concept: "cuaderno", priority: 1, when: { match: /\babc\b/, attrs: { hojas: 60 } }, prefer: [{ sku: "042551" }] },
  { id: "cuaderno-abc", concept: "cuaderno", when: { match: /\babc\b|a4.*tapa dura|tapa dura.*a4/ }, prefer: [{ sku: "41149" }, { sku: "042551" }] },
  { id: "carpeta-solapas", concept: "carpeta_solapas", prefer: [{ sku: "61447" }, { sku: "61446" }] },
  { id: "carpeta-cristal", concept: "carpeta_cristal", prefer: [{ sku: "60708" }] },
  { id: "carpeta-3-anillos", concept: "carpeta", when: { notMatch: /2 anillos|\b2a\b|oficio|lomo/ }, exclude: [/\b2 ?a\b/, /2 anillos/, /lomo ancho/] },

  // ── Arte ──────────────────────────────────────────────────────────
  { id: "tempera-pote", concept: "tempera", when: { notMatch: /surtid|x ?\d|caja|set|fluo/ }, prefer: [{ sku: "260039" }] },
  { id: "goma-eva-glitter", concept: "goma_eva", priority: 1, when: { attrs: { acabado: "glitter" } }, prefer: [{ sku: "990181" }] },
  { id: "goma-eva-lisa", concept: "goma_eva", when: { notMatch: /metaliz|toalla|plancha grande|textur/ }, prefer: [{ sku: "990003" }] },
  { id: "marcador-pizarra", concept: "marcador_pizarra", when: { notMatch: /recargable|x ?4|set/ }, prefer: [{ sku: "011148" }] },
  { id: "marcador-permanente", concept: "marcador_permanente", prefer: [{ sku: "10908" }] },
  { id: "acuarela", concept: "acuarela", when: { notMatch: /profesional|lata|tubo/ }, prefer: [{ sku: "312095" }] },
  { id: "pincel-set", concept: "pincel", priority: 1, when: { match: /\bset\b|juego/ }, prefer: [{ sku: "240220" }] },
  { id: "pincel-chato", concept: "pincel", when: { match: /chato/ }, prefer: [{ sku: "240274" }] },
  { id: "pincel", concept: "pincel", prefer: [{ sku: "240283" }] },
  { id: "fibras-escolares", concept: "fibra_color", when: { notMatch: /doble punta|brush|sketch|artistic|lettering|micro/ },
    boost: [/fibra colou?r x1[02]\b/], exclude: [/x(4[0-9]|[5-9][0-9]|1[0-9]{2})\b/, /doble punta/, /brush/, /sketch/, /artistic/, /lettering/] },
  { id: "lapices-color-escolares", concept: "lapiz_color", when: { notMatch: /acuarelable|artistic|profesional|lata/ },
    boost: [/\bx ?12\b/], exclude: [/\blata\b/, /x(4[0-9]|[5-9][0-9]|1[0-9]{2})\b/] },
  { id: "crayones-escolares", concept: "crayon", when: { notMatch: /artistic|pastel oleo/ }, boost: [/\bx ?12\b/], exclude: [/artistic/] },
  { id: "palitos-helado", concept: "palitos", priority: 1, when: { match: /helado|paleta|baja ?lengua/ }, prefer: [{ sku: "130122" }] },
  { id: "palitos", concept: "palitos", prefer: [{ sku: "130124" }] },

  // ── Varios ────────────────────────────────────────────────────────
  { id: "tiza-blanca", concept: "tiza", priority: 1, when: { attrs: { acabado: "blanco" } }, prefer: [{ sku: "10076" }] },
  { id: "tiza-blanca-palabra", concept: "tiza", priority: 1, when: { match: /blanca/ }, prefer: [{ sku: "10076" }] },
  { id: "tiza", concept: "tiza", prefer: [{ sku: "10078" }] },
  { id: "tijera-escolar", concept: "tijera", when: { notMatch: /zurd|metal|oficina|\b(17|19|20|21)\s?cm/ }, prefer: [{ sku: "340188" }, { sku: "340134" }] },
  { id: "regla-30", concept: "regla", priority: 1, when: { attrs: { medida: "30cm" } }, prefer: [{ sku: "71084" }] },
  { id: "regla-flexible", concept: "regla", priority: 1, when: { match: /flexible|blanda/ }, boost: [/flexible/] },
  { id: "regla", concept: "regla", when: { notMatch: /acero|metal/ }, prefer: [{ sku: "70002" }] },
  { id: "geometria-30", concept: "juego_geometria", priority: 1, when: { attrs: { medida: "30cm" } }, prefer: [{ sku: "70037" }] },
  { id: "geometria", concept: "juego_geometria", prefer: [{ sku: "70007" }] },
  { id: "globos", concept: "globos", prefer: [{ sku: "411186" }] },
];

// Productos con una característica que sólo deben ofrecerse si el pedido la menciona.
const EXCLUDE_UNLESS_REQUESTED = [
  { product: /zurd/, request: /zurd/ },
  { product: /oxford/, request: /oxford/ },
  { product: /con folios/, request: /con folios/ },
  { product: /recargable|tinta de recarga/, request: /recarga/ },
  { product: /\bdisney|marvel|stitch|harry potter|mickey|minnie|avengers|spiderman|sonic|garfield|inter miami|capybara|kuromi|pusheen|lotso|hello kitty|frozen|barbie|paw patrol|star ?wars|mandalorian|boca|river|afa/,
    request: /disney|marvel|stitch|harry|mickey|minnie|avengers|spider|sonic|garfield|miami|capybara|kuromi|pusheen|lotso|kitty|frozen|barbie|paw|star|mandalorian|boca|river|afa/, soft: true },
];

// Unidades por paquete cuando ni el nombre ni la variante lo dicen, por SKU: { "150019": 10 }.
// Las variantes "A4 Comun x10" / "x100" y los nombres "x12", "x 50 u." se detectan solos.
const UNITS_PER_PACK = {};

module.exports = { RULES, EXCLUDE_UNLESS_REQUESTED, UNITS_PER_PACK };
