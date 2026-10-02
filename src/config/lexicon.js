// Lenguaje escolar argentino → conceptos de producto.
//
// Este archivo es la defensa principal contra falsos positivos: un pedido sólo puede matchear productos
// del mismo concepto (o de los conceptos que el concepto acepta explícitamente). "lápiz" nunca puede
// terminar en una birome porque son conceptos distintos.
//
// Cómo editar:
//   - Los patrones se evalúan sobre texto normalizado (minúsculas, sin tildes, "N°3" → "n3", "x 12" → "x12").
//   - req:  patrones que reconocen el concepto en lo que pidió la familia.
//   - prod: patrones que reconocen el concepto en el nombre del producto del catálogo.
//   - Si varios conceptos matchean, gana el que aparece primero en el texto; si empatan, el que está
//     más arriba en esta lista (por eso los más específicos van antes: "goma eva" antes que "goma").
//   - dims: atributos que importan para el concepto (ver src/matching/attributes.js). Si el pedido y el
//     producto especifican valores distintos de una dim, el producto se descarta (A4 vs oficio, etc.).
//   - packUnit: el producto se vende en paquetes de N unidades de esto ("20 folios" → 2 paquetes x10).
//   - outOfScope: no lo vendemos; se informa con este motivo y no se busca nada.
//   - accepts: otros conceptos que también son válidos para este pedido.
//   - reqFallback: patrones genéricos que sólo cuentan si ningún concepto específico matcheó ("hojas" a secas).
//   - compat: pares de valores que no son conflicto para este concepto ({ formato: [["n3", "a4"]] }).
//   - unitWords: palabras con las que se cuentan unidades sueltas ("12 fibrones" → fibra_color).
//   - alwaysReview: el resultado siempre queda "para revisar" (pocas opciones online o muy caras).
//
// Las reglas comerciales (producto preferido, excluidos, marcas) van en config/matchingRules.js, no acá.

const PAPER = ["formato", "rayado", "hojas"];

const CONCEPTS = [
  // ── Fuera de alcance (no se buscan) ───────────────────────────────
  { id: "higiene", label: "Higiene y limpieza", outOfScope: "Artículo de higiene o limpieza: consultá en la sucursal.",
    req: [/papel higienico/, /\bjabon/, /alcohol( en gel)?\b/, /toallita/, /panuelo/, /servilleta/, /rollos? (de )?cocina/,
      /cepillo de dientes/, /pasta dental/, /\btoallas?\b/, /desinfectante/, /lavandina/, /\bbarbijo/, /papel de cocina/,
      /\bhisopos?\b/, /algodon/, /pano de limpieza/, /gel para (el )?cabello/, /\bpeine\b/] },
  { id: "libros", label: "Libros", outOfScope: "Los libros de texto no están en el catálogo online: consultá con un asesor.",
    req: [/\blibros?\b/, /\bbiblia/, /team together/, /\bmanual\b(?! de estilo)/, /\bcuentos?\b/, /\bnovela/, /\btexto\b/,
      /\brevistas?\b/, /cuadernillo/, /\bcartillas?\b/, /bibliografia/, /student.?s book|pupil.?s book|activity book|workbook/, /\breaders?\b/,
      /\bbook\b/, /\bed\.? (santillana|kapelusz|estrada|puerto de palos|tinta fresca|mandioca|sm|edelvives|oxford|pearson|macmillan|cambridge|longseller)/,
      /santillana|kapelusz|editorial|edelvives|macmillan|pearson/, /\bestampa/] },
  { id: "educacion_fisica", label: "Educación física y uniforme", outOfScope: "Artículo deportivo o de uniforme: no está en el catálogo.",
    req: [/\bhockey\b/, /\bbocha\b/, /protector bucal/, /canillera/, /zapatilla/, /\bremera\b/, /\bjogging\b/, /\buniforme\b/,
      /\bshort\b/, /\bmedias\b/, /\bpollera\b/, /delantal/, /guardapolvo/, /\bchomba\b/, /\bjoggin/, /\bcamisa\b/, /\bgorra\b/, /\bbuzo\b/, /campera/] },
  { id: "uso_personal", label: "Elementos personales", outOfScope: "Elemento de uso personal: no está en el catálogo.",
    req: [/\btazas?\b/, /\bindividual\b/, /servilleta/, /\bbolsita/, /\bcuchar/, /\bplatos?\b/, /\bmantel/, /cuchillo/, /tenedor/,
      /bolsa de (lienzo|tela)/, /lienzo ecologico/, /\bvasos?\b/, /\bsorbetes?\b/, /alfiler/, /\bovillo\b/, /\blanas?\b/, /lanitas/,
      /retazos/, /\bcorchos?\b/, /tapitas/, /papel de diario/, /palito de crochet/, /\blija\b/, /descartables?/,
      /broches? de (madera|ropa)/, /ganchos? de ropa/, /recipiente/, /vasito/, /\belastico de \d/] },
  { id: "ciencias_cocina", label: "Ciencias y cocina", outOfScope: "Material de ciencias o cocina: no está en el catálogo.",
    req: [/bicarbonato/, /\bfecula/, /cremor tartaro/, /colorante/, /harina/, /semola/, /vinagre/, /\baceite\b/, /\bsal fina\b|paquete de sal/,
      /papel aluminio/, /\bazucar\b/, /espuma de afeitar/, /jeringa/, /gotero/, /rociador/,
      /pulverizador/, /\besponja/, /papel film/, /\bvasos? descartable/, /\bplatos? descartable/, /tenedor/,
      /\bcuchara/, /\bservilletero/, /\brodillo/, /\btaza\b/, /\bbotones\b/, /\btelas?\b/, /\blanillas?\b/, /\btablet\b/] },

  // ── Escritura ──────────────────────────────────────────────────────
  { id: "corrector", label: "Corrector", req: [/corrector/, /liquid paper/, /cinta correctora/], prod: [/corrector/] },
  { id: "borratinta", label: "Borratinta", req: [/borra ?tinta/], prod: [/borratinta/] },
  { id: "cartucho_tinta", label: "Cartuchos de tinta", req: [/cartucho/], prod: [/cartucho/], packUnit: "cartucho" },
  { id: "pluma", label: "Pluma estilográfica", alwaysReview: true, req: [/lapiceras? (de )?tinta( azul)?( lavable)?/, /tinta (azul )?lavable/, /\bpluma\b/, /lapicera (de )?pluma/, /lapicera (a|de) cartucho/], prod: [/\bpluma\b/, /fountain/, /\bfp\b/] },
  { id: "boligrafo_borrable", label: "Bolígrafo borrable", req: [/(lapicera|boligrafo|birome|roller)s?\b.*(borrable|con borrador)/, /borrable/, /frixion/], prod: [/borrable/, /frixion/, /gelocity ilusion/] },
  { id: "adhesivo_barra", label: "Adhesivo en barra", req: [/plasticolas? (chica |mediana |grande |pequena )?en barra/, /(barra|barrita)s? de plasticola/, /lapiz adhesivo/, /barra adhesiva(?!.*silicona)/, /adhesivo en barra/, /\bpritt\b/, /\bstick\b/],
    prod: [/lapiz adhesivo/, /barra adhesiva(?!.*silicona)/, /adhesivo en barra/, /\badh barra/, /\bstick\b/] },
  { id: "lapiz_color", label: "Lápices de colores", dims: ["largo", "cantidadColores"], packUnit: "lapiz",
    req: [/lapi(z|ces) (de )?colou?r/, /colou?r(es)? lapi/, /caja (de )?lapi(z|ces)/, /lapi(z|ces) x\d/, /lapices largos/, /lapi(z|ces) acuarelable/],
    prod: [/lapi(z|ces) (de )?colou?r/, /colou?r(es)? lapi/, /lapi(z|ces)\b.*\bx\d+/, /lapi(z|ces) acuarelable/, /\bsupermina\b/] },
  { id: "portaminas", label: "Portaminas", dims: ["mina"], req: [/portamina/], prod: [/portamina/] },
  { id: "minas", label: "Minas", dims: ["mina"], req: [/\bminas?\b/, /repuesto (de )?minas/], prod: [/\bminas?\b/] },
  { id: "lapiz_grafito", label: "Lápiz negro", dims: ["dureza"], packUnit: "lapiz",
    req: [/\blapi(z|ces)\b/, /\bgrafito\b/], prod: [/\blapi(z|ces)\b/],
    notProd: [/lapicera/, /portamina/, /adaptador/, /\bgrip\b/, /porta ?lapiz/, /iluminador/, /marcadores/, /\bkit\b/] },
  { id: "boligrafo", unitWords: ["boligrafo", "birome", "lapicera"], label: "Bolígrafo / birome", dims: ["punta"], packUnit: "boligrafo",
    req: [/\bbiromes?\b/, /\blapiceras?\b/, /\bboligrafos?\b/, /\bbolig\b/, /\broller\b/, /\bbic\b(?!.*(lapiz|marcador|resaltador|corrector))/],
    prod: [/\bboligrafos?\b/, /\bbolig\b/, /\bbiromes?\b/, /\blapiceras?\b/, /\broller\b/],
    notProd: [/borrable/, /frixion/, /fountain/, /\bfp\b/, /\brepuesto\b/] },

  // ── Corrección, borrado, sacapuntas ────────────────────────────────
  { id: "borrador_pizarra", label: "Borrador de pizarra", req: [/borrador.*(pizarra|pizarron)/], prod: [/borrador.*(pizarra|pizarron)/] },
  { id: "goma_eva", label: "Goma eva", dims: ["acabado", "formato"],
    req: [/gomas? ?eva/, /gomaeva/, /goma de eva/], prod: [/goma ?eva/] },
  { id: "plasticola", label: "Adhesivo vinílico (plasticola)", dims: ["acabado"],
    req: [/plasticola/, /cola vinilica/, /adhesivo vinilico/, /adhesivo escolar/, /goma de pegar/, /pegamento/, /\badhesivo\b(?!.*(barra|silicona|cinta|contacto|instantaneo))/],
    prod: [/plasticola/, /cola vinilica/, /adhesivo (vinilico|escolar|con glitter)/, /adhesivo (sta|elmers|pelikan)\b/, /adhesivo.*glitter/],
    notProd: [/voligoma/, /barra/] },
  { id: "adhesivo_universal", label: "Adhesivo universal / contacto",
    req: [/adhesivo (universal|de contacto|instantaneo)/, /\bpoxi/, /\buhu\b/, /la gotita/],
    prod: [/\badhesivo\b/, /\bpoxi/, /\buhu\b/, /unipox/, /eccole/],
    notProd: [/barra/, /silicona/, /voligoma/, /plasticola/, /cola vinilica/, /escolar/, /glitter/, /elmers/, /\bsta\b/] },
  { id: "voligoma", label: "Voligoma", req: [/voligoma/, /boligoma/], prod: [/voligoma/] },
  { id: "goma_borrar", label: "Goma de borrar",
    req: [/gomas? (de )?borrar/, /\bborrador(es)?\b/, /\bgomas?\b(?! ?(eva|de pegar))/, /goma lapiz/],
    prod: [/gomas? (de )?borrar/, /\bgoma\b(?! ?eva)/], notProd: [/goma ?eva/, /\bgoma (arabiga|laca)/] },
  { id: "sacapuntas", label: "Sacapuntas", req: [/saca ?puntas?/], prod: [/saca ?puntas?/] },

  // ── Marcadores ─────────────────────────────────────────────────────
  { id: "resaltador", label: "Resaltador", req: [/resaltador/, /marcador(es)? (fluo|fluor)/, /fluorescente/, /\bfibron fluo/],
    prod: [/resaltador/] },
  { id: "marcador_pizarra", label: "Marcador para pizarra", req: [/(marcador|fibron|fibra|felpon)(es|as)?\b.*(pizarra|pizarron)/, /(pizarra|pizarron).*(marcador|fibron)/],
    prod: [/(marcador|fibra)(es|s)?\b.*(pizarra|pizarron)/, /p ?\/? ?pizarra/, /\bpizarra\b.*\btrabi\b/, /whiteboard/] },
  { id: "marcador_permanente", label: "Marcador permanente",
    req: [/(marcador|fibron|fibra|felpon)(es|as)?\b.*(permanente|indeleble)/, /permanente/, /indeleble/, /sharpie/],
    prod: [/permanente/, /indeleble/, /edding 400/, /sharpie/] },
  { id: "marcador_acrilico", label: "Marcador acrílico", req: [/marcador(es)? acrilic/], prod: [/marcador(es)? acrilic/, /acrylic marker/] },
  { id: "tempera_solida", label: "Témpera sólida", req: [/tempera(s)? (solida|en barra)/], prod: [/tempera solida/] },
  { id: "fibra_color", unitWords: ["fibra", "fibron", "marcador", "felpon", "microfibra"], label: "Fibras / fibrones", dims: ["punta", "cantidadColores"], packUnit: "fibra",
    req: [/\bfibr(a|as|on|ones)\b/, /\bfelpon/, /\bmarcador(es)?\b/, /marca ?todo/, /microfibra/],
    prod: [/\bfibra(s)?\b/, /\bfibron/, /\bmarcador(es)?\b/, /marca ?todo/, /microfibra/],
    notProd: [/sharpie/, /permanente/, /pizarra/, /acrilic/, /\btiza\b/, /resaltador/, /tempera solida/] },
  { id: "crayon", unitWords: ["crayon", "cera"], label: "Crayones", packUnit: "crayon", req: [/crayon/, /crayola/, /\bceras?\b/], prod: [/crayon/] },

  // ── Pintura y modelado ────────────────────────────────────────────
  { id: "tempera", label: "Témpera", dims: ["acabado"], req: [/tempera/], prod: [/tempera/] },
  { id: "acuarela", label: "Acuarela", req: [/acuarela/], prod: [/acuarela(?!ble)/] },
  { id: "pintura_acrilica", label: "Pintura acrílica", req: [/acrilic/], prod: [/acrilic/], notProd: [/marcador/, /regla/, /atril/, /impermeabiliz/, /barniz/] },
  { id: "pincel", label: "Pincel", req: [/pincel/], prod: [/pincel/] },
  { id: "plastilina", unitWords: ["plastilina", "barra", "barrita"], label: "Plastilina", packUnit: "plastilina", req: [/plastilina/], prod: [/plastilina/] },
  { id: "masa", label: "Masa para modelar", req: [/masa(s)? (para )?modelar/, /porcelana fria/, /\bmasas?\b/, /foamy moldeable/],
    prod: [/\bmasa(s)?\b/, /porcelana fria/, /foamy moldeable/] },

  // ── Adhesivos, cintas, sujeción ────────────────────────────────────
  { id: "silicona_barra", label: "Barras de silicona", dims: ["grosor"], req: [/barr(a|as|ita|itas) (de )?silicona/, /silicona en barra/],
    prod: [/barra(s)? adhesiva(s)? de silicona/, /barra(s)? (de )?silicona/] },
  { id: "pistola_silicona", label: "Pistola de silicona", req: [/pistola/], prod: [/pistola/] },
  { id: "silicona_liquida", label: "Silicona líquida", req: [/silicona/], prod: [/silicona liquida/] },
  { id: "cinta_papel", label: "Cinta de papel", req: [/cinta (de )?papel/, /cinta de enmascarar/, /masking/], prod: [/cinta (de )?papel/, /masking/] },
  { id: "cinta_bifaz", label: "Cinta bifaz", req: [/bifaz/, /doble faz/], prod: [/bifaz/, /doble faz/] },
  { id: "cinta_raso", label: "Cinta de raso", req: [/cinta (de )?(raso|razo|bebe)/], prod: [/cinta (de )?raso/] },
  { id: "cinta_adhesiva", label: "Cinta adhesiva", req: [/cinta (de )?embalar/, /cinta scotch/, /\bscotch\b/, /cinta adhesiva/, /cinta transparente/, /\bcinta ancha/, /cinta pack/],
    prod: [/cinta(s)? adhesiva/, /cinta adh\b/, /cinta (de )?embalar/, /cinta transparente/], notProd: [/decorativa/, /bifaz/] },
  { id: "ojalillos", label: "Ojalillos", packUnit: "ojalillo", req: [/ojalillo/], prod: [/ojalillo/] },
  { id: "broches_abrochadora", label: "Broches para abrochadora", req: [/broches? (para )?abrochadora/, /broches? n ?(10|21|26)/, /broches? 26\/6/],
    prod: [/broches? (n ?)?(10|21|24|26)/, /broches?.*\bp(ara)? ?abrochadora/] },
  { id: "broches_nepaco", label: "Broches nepaco / mariposa", req: [/nepaco/, /broches? (de )?carpeta/, /broches? mariposa/, /dos puntas/],
    prod: [/nepaco/, /broches? mariposa/, /dos puntas/] },
  { id: "abrochadora", label: "Abrochadora", req: [/abrochadora/, /engrapadora/, /engrampadora/], prod: [/abrochadora/, /engrampadora/] },
  { id: "cutter", label: "Cutter", req: [/\bcutter\b/, /trincheta/], prod: [/\bcutter\b/] },
  { id: "sacabocados", label: "Sacabocados", req: [/sacabocado/], prod: [/sacabocado/] },
  { id: "perforadora", label: "Perforadora", req: [/perforad(ora|or)/], prod: [/perforad(ora|or)/] },
  { id: "clips", label: "Clips", req: [/\bclips?\b/], prod: [/\bclips?\b/] },
  { id: "chinches", label: "Chinches", req: [/chinche/], prod: [/chinche/] },
  { id: "elasticos", label: "Bandas elásticas", req: [/(bandas|banditas|gomitas) elastica/, /\bgomitas?\b/], prod: [/banda(s)? elastica/] },
  { id: "banderitas", label: "Banderitas / notas adhesivas", req: [/banderita/, /notas? (auto)?adhesiva/, /post ?it/, /taco (de )?notas/],
    prod: [/banderita/, /notas? (auto)?adhesiva/, /taco (de )?nota/, /taco adhesivo/] },
  { id: "etiquetas", label: "Etiquetas", req: [/etiqueta/], prod: [/etiqueta/] },

  // ── Papeles ───────────────────────────────────────────────────────
  // Folio "N°3" en las listas = folio A4 (es el que entra en la carpeta N°3).
  { id: "folio", label: "Folios", dims: ["formato"], compat: { formato: [["n3", "a4"]] }, packUnit: "folio", req: [/\bfolios?\b/], prod: [/\bfolios?\b/] },
  { id: "hojas_a4", packSizeRequired: true, unitWords: ["hoja"], label: "Hojas A4 / resma", dims: ["formato", "acabado"], packUnit: "hoja",
    req: [/\bresmas?\b/, /\bhojas?\b.*\b(a4|oficio|carta)\b(?!.*(carpeta|rayad|cuadricul|canson|dibujo|repuesto))/, /\b(a4|oficio)\b.*\bhojas?\b(?!.*(carpeta|rayad|cuadricul|canson|dibujo))/,
      /hojas? (de )?(maquina|impresora|fotocopia)/, /papel (a4|oficio|obra)\b/],
    prod: [/\bresmas?\b/, /\bhojas? a4\b/, /papel (a4|oficio|obra)\b/] },
  { id: "repuesto_dibujo", packSizeRequired: true, unitWords: ["hoja"], label: "Hojas de dibujo (canson)", dims: ["formato", "acabado"], packUnit: "hoja",
    req: [/canson/, /hojas? (de )?dibujo/, /repuestos? (de )?(dibujo|canson)/, /repuestos? (de )?hojas? (de )?(colou?r|negras?|blancas?)/, /\brep\.? canson/, /hojas? (de )?colou?r(es)?\b/, /hojas? negras?/, /hojas? blancas? n\d/],
    prod: [/repuesto (de )?dibujo/, /repuesto canson/, /hojas? canson/, /repuesto n ?\d+ (blanco|color|negro)/, /\brepuesto\b.*\b(color|negro|blanco)\b.*\bn\d/], accepts: ["block_dibujo"] },
  { id: "papel_calcar", label: "Papel de calcar", req: [/calcar/, /papel manteca/], prod: [/calcar/] },
  { id: "repuesto_hojas", packSizeRequired: true, unitWords: ["hoja"], label: "Repuesto de hojas para carpeta", dims: PAPER, packUnit: "hoja",
    req: [/hojas? (de |para )?carpeta/, /\brepuestos?\b(?! (de )?(papel madera|canson|dibujo|calcar|hojas? (de )?(colou?r|negras?|blancas?)))/, /\bhojas? (rayadas?|cuadriculadas?|lisas?|renglonadas?)/, /\bhojas? n ?3\b/, /hojas? (de )?(rivadavia|triunfante|gloria|exito)/,
      /\bhojas?\b.*\b(rayad|cuadricul|renglon)/, /\bhojas?\b.*\b(para|de) carpeta/],
    reqFallback: [/\bhojas?\b/],
    prod: [/\brepuestos?\b/, /hojas? (rayadas|cuadriculadas)/],
    notProd: [/parker/, /boligrafo/, /roller/, /rotring/, /locorrijo/, /calcar/, /dibujo/, /pentagram/, /ballpoint/, /faber magic/, /\bminas?\b/, /\bpunta\b/] },
  { id: "papel_carbonico", label: "Papel carbónico", req: [/carbonico/], prod: [/carbonico/] },
  { id: "pentagramado", label: "Hojas pentagramadas", req: [/pentagram/], prod: [/pentagram/] },
  { id: "papel_satinado", label: "Papel satinado", req: [/papel satinado/], prod: [/papel satinado/] },
  { id: "block_cartulina", label: "Block de cartulinas", dims: ["formato"], req: [/blocks?\b.*(cartulina|fantasia|entretenid)/, /cartulinas? (en )?block/],
    prod: [/block.*(cartulina|fantasia|entretenid)/] },
  { id: "block_afiche", label: "Block de afiches", dims: ["formato"], req: [/blocks? (de )?afiche/], prod: [/block.*afiche/] },
  { id: "block_papel_madera", label: "Block de papel madera", req: [/blocks?\b.*(papel madera|kraft)/, /repuestos? (de )?papel madera/], prod: [/block.*(papel madera|kraft)/],
    accepts: ["papel_madera"] },
  { id: "block_notas", label: "Anotador / block de notas", req: [/anotador/, /block (de )?notas/, /block a[45] (rayado|cuadriculado)/], prod: [/anotador/, /block (de )?notas/] },
  { id: "block_dibujo", label: "Block de dibujo", dims: ["formato", "acabado"],
    req: [/\bblocks?\b/], prod: [/\bblock\b/], notProd: [/cartulina/, /afiche/, /papel madera/, /notas/] },
  { id: "cartulina", label: "Cartulina", dims: ["acabado"], packUnit: "cartulina", req: [/cartulina/], prod: [/cartulina/] },
  { id: "afiche", label: "Papel afiche", packUnit: "afiche", req: [/afiche/], prod: [/afiche/] },
  { id: "papel_madera", label: "Papel madera", packUnit: "pliego", req: [/papel (de )?madera/], prod: [/papel madera/] },
  { id: "papel_glase", label: "Papel glasé", dims: ["acabado"], req: [/\bgla(s|c)e\b/, /papel lustre/], prod: [/\bgla(s|c)e\b/] },
  { id: "papel_crepe", label: "Papel crepé", req: [/crepe/], prod: [/crepe/] },
  { id: "papel_seda", label: "Papel seda / barrilete", req: [/papel (de )?seda/, /papel (de )?(barrilete|cometa)/], prod: [/papel seda/, /cometa/] },
  { id: "papel_contact", label: "Papel contact", req: [/\bcontac?t?\b/, /papel autoadhesivo/], prod: [/\bcontact?\b/] },
  { id: "papel_celofan", label: "Papel celofán / acetato", req: [/celofan/, /acetato/], prod: [/celofan/, /acetato/] },
  { id: "papel_arana", label: "Papel araña", req: [/papel arana/], prod: [/arana/] },
  { id: "papel_metalizado", label: "Papel metalizado", req: [/papel metalizado/], prod: [/papel metalizado/] },
  { id: "carton_corrugado", label: "Cartón corrugado", req: [/corrugado/, /acartonad/], prod: [/corrugado/] },
  { id: "papel_forro", label: "Papel para forrar", req: [/forrar/, /\bforros?\b/, /papel (de )?forrar/], prod: [/forro/, /forrar/] },

  // ── Cuadernos y carpetas ──────────────────────────────────────────
  { id: "cuaderno_comunicaciones", label: "Cuaderno de comunicaciones", req: [/cuadernos? (de |para )?(los )?comunica/, /comunicad/, /comunicacion/], prod: [/comunicacion/] },
  { id: "cuaderno_caligrafia", label: "Cuaderno de caligrafía", req: [/cuadernos? (de )?caligraf/, /caligraf/], prod: [/caligraf/] },
  { id: "cuaderno", label: "Cuaderno", dims: ["formato", "rayado", "hojas", "tapa", "espiral"],
    req: [/cuadern/], prod: [/cuadern/], notProd: [/repuesto/, /forro/, /comunicacion/, /caligraf/] },
  { id: "carpeta_solapas", label: "Carpeta con solapas", dims: ["formato"], req: [/carpeta.*solapa/, /solapas/], prod: [/carpeta.*solapa/] },
  { id: "carpeta_cristal", label: "Carpeta tapa cristal", dims: ["formato"], req: [/carpeta.*(cristal|transparente|en l\b|tapa plastica)/, /tapa cristal/],
    prod: [/carpeta.*(cristal|transparente)/] },
  { id: "bibliorato", label: "Bibliorato", req: [/bibliorato/], prod: [/bibliorato/] },
  { id: "carpeta", label: "Carpeta escolar", dims: ["formato"], req: [/carpeta/], prod: [/carpeta/], notProd: [/^aros/, /aros para/] },
  { id: "libreta", label: "Libreta", req: [/libreta/], prod: [/libreta/, /bitacora/] },
  { id: "separadores", label: "Separadores", req: [/separador/], prod: [/separador/] },
  { id: "aros_carpeta", label: "Aros para carpeta", req: [/\baros?\b.*(metalic|carpeta|\d+ ?mm)/, /anillos (metalicos|para carpeta|de \d+ ?mm)/], prod: [/aros para carpeta/] },
  { id: "plastificar", label: "Lámina para plastificar", req: [/plastific/], prod: [/plastific/] },
  { id: "caratulas", label: "Carátulas", req: [/caratula/], prod: [/caratula/] },
  { id: "papel_regalo", label: "Papel de regalo", req: [/papel (de )?regalo/], prod: [/papel de regalo/] },
  { id: "agenda", label: "Agenda", req: [/agenda/], prod: [/agenda/] },

  // ── Geometría ─────────────────────────────────────────────────────
  { id: "juego_geometria", label: "Juego de geometría", dims: ["medida"],
    req: [/(juego|set|elementos|kit) (de )?geometria/, /\bgeometria\b/], prod: [/geometria/] },
  { id: "escuadra", label: "Escuadra", dims: ["medida"], req: [/escuadra/], prod: [/escuadra/] },
  { id: "transportador", label: "Transportador", req: [/transportador/], prod: [/transportador/] },
  { id: "compas", label: "Compás", req: [/\bcompas\b/], prod: [/\bcompas\b/] },
  { id: "regla", label: "Regla", dims: ["medida"], req: [/\breglas?\b/], prod: [/\breglas?\b/] },
  { id: "plantilla", label: "Plantilla de dibujo", req: [/plantilla/], prod: [/plantilla/] },

  // ── Varios ────────────────────────────────────────────────────────
  { id: "tijera", label: "Tijera", dims: ["zurdo", "medida"], req: [/tijer/], prod: [/tijer/] },
  { id: "tiza", label: "Tizas", dims: ["acabado"], packUnit: "tiza", req: [/\btizas?\b/], prod: [/\btizas?\b/],
    notProd: [/pintura a la tiza/, /pastel a la tiza/, /marcador/] },
  { id: "limpiapipas", label: "Limpiapipas", packUnit: "limpiapipa", req: [/limpia ?pipa/], prod: [/limpia ?pipa/] },
  { id: "escarapela", label: "Escarapela", req: [/escarapela/], prod: [/escarapela/] },
  { id: "tabla_periodica", label: "Tabla periódica", req: [/tabla periodica/], prod: [/tabla periodica/] },
  { id: "paleta", label: "Paleta de pintor", req: [/paleta (de )?(pintor|pintura)/], prod: [/paleta de pintor/] },
  { id: "mapa", label: "Mapa", dims: ["formato", "tipoMapa"], packUnit: "mapa", req: [/\bmapas?\b/, /planisferio/], prod: [/\bmapas?\b/, /planisferio/], notProd: [/encastre/, /rompecabezas/] },
  { id: "globo_terraqueo", label: "Globo terráqueo", req: [/globo terraqueo/, /terraqueo/], prod: [/globo terraqueo/] },
  { id: "globos", label: "Globos", packUnit: "globo", req: [/\bglobos?\b/], prod: [/\bglobos?\b/], notProd: [/terraqueo/] },
  { id: "palitos", label: "Palitos de madera", packUnit: "palito", req: [/palito/, /baja ?lengua/], prod: [/palito/] },
  { id: "multibase", label: "Multibase", req: [/multibase/], prod: [/multibase/] },
  { id: "abaco", label: "Ábaco", req: [/\babaco\b/], prod: [/\babaco\b/] },
  { id: "diccionario", label: "Diccionario", req: [/diccionario/], prod: [/diccionario/] },
  { id: "pendrive", label: "Pendrive", req: [/pen ?drive/], prod: [/pen ?drive/] },
  { id: "calculadora", label: "Calculadora", req: [/calculadora/], prod: [/calculadora/] },
  { id: "cartuchera", label: "Cartuchera / canopla", req: [/cartuchera/, /canopla/], prod: [/cartuchera/, /canopla/] },
  { id: "mochila", label: "Mochila", req: [/mochila/], prod: [/mochila/] },
  { id: "flauta", label: "Flauta", req: [/flauta/], prod: [/flauta/] },
  { id: "pizarra", label: "Pizarra", req: [/\bpizarra\b/, /\bpizarron\b/], prod: [/\bpizarra\b/] },
  { id: "lupa", label: "Lupa", req: [/\blupa\b/], prod: [/\blupa\b/] },
  { id: "sobre", label: "Sobres", req: [/^\d*\s*sobres? (de )?(tamano )?(papel madera|manila|blanco|carta|oficio)/, /sobres? (de )?carta/], prod: [/^sobre/] },
  { id: "bastidor", label: "Bastidor / lienzo", req: [/bastidor/, /lienzo para pintar/], prod: [/bastidor/] },
  { id: "rompecabezas", label: "Juegos didácticos", outOfScope: "Juegos didácticos: consultá disponibilidad con un asesor.",
    req: [/rompecabezas/, /juegos? (didactico|de memoria|de mesa|de encastre)/, /\bmemotest/, /\bencastre/] },
];

// Marcas: se reconocen en pedidos y productos. "o similar" vuelve la marca opcional.
const BRANDS = [
  "bic", "maped", "pelikan", "faber", "faber castell", "filgo", "luma", "rivadavia", "laprida", "sta", "alba", "sifap",
  "eterna", "trabi", "ezco", "carioca", "giotto", "pizzini", "simball", "sabonis", "koby", "el nene", "muresco", "exito",
  "iglu", "auca", "playcolor", "edding", "oxford", "norpac", "triunfante", "gloria", "america", "ledesma", "stabilo",
  "staedtler", "paper mate", "parker", "olami", "deli", "writech", "uni", "sharpie", "crayola", "prismacolor", "derwent",
  "kingston", "casio", "voligoma", "plasticola", "2 banderas", "dos banderas", "onix", "keyroad", "tuky", "cresko",
  "mooving", "talbot", "arte", "acrilex", "fw", "lsd", "wero", "scrikss", "mit", "boligoma", "stanford", "ppr",
];

// Palabras de envase: si el pedido dice "2 cajas de…", la cantidad es de paquetes, no de unidades.
const CONTAINER_UNITS = ["caja", "paquete", "paq", "sobre", "pack", "set", "estuche", "blister", "bolsa", "lata", "kit", "juego", "block", "resma", "plancha", "rollo", "frasco", "pote", "tubo", "pliego"];

// Palabras que pueden ir antes del producto sin cambiar qué es ("1 pliego de papel madera", "un par de…").
// Si antes del concepto reconocido hay otra palabra desconocida ("cortante de masa"), el pedido NO es ese concepto.
const HEAD_FILLERS = ["papel", "unidad", "unidades", "pieza", "piezas", "par", "pares", "tira", "tiras", "metro", "metros",
  "kg", "kilo", "gr", "grs", "g", "cc", "ml", "litro", "medio", "pequeno", "pequena", "paleta", "especial", "comun",
  "hoja", "hojas", "cantidad", "nuevo", "nueva", "grande", "chico", "chica", "mediano", "mediana", "buen", "buena", "uso", "escolar"];

// Correcciones de tipeo frecuentes en listas escolares (se aplican antes de reconocer conceptos).
// Además de esta tabla, src/matching/requestParser.js corrige por distancia de edición contra el vocabulario.
const TYPOS = {
  lapis: "lapiz", lapizes: "lapices", virome: "birome", viromes: "biromes", plastisola: "plasticola",
  fivra: "fibra", fivras: "fibras", tigera: "tijera", tigeras: "tijeras", cuadreno: "cuaderno", carpta: "carpeta",
  glasse: "glase", glasé: "glase", tempra: "tempera", rezma: "resma", gomaeva: "goma eva", crayolas: "crayones",
  sacapunta: "sacapuntas", bligrafo: "boligrafo", cartulna: "cartulina", plastilna: "plastilina",
  rep: "repuesto", repto: "repuesto", carp: "carpeta", hjs: "hojas",
};

module.exports = { CONCEPTS, BRANDS, CONTAINER_UNITS, HEAD_FILLERS, TYPOS };
