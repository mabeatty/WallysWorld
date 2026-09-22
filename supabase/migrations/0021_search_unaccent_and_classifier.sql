-- 0021: two fixes found while adding Pokemon lots. (1) Text search did exact substring matching,
-- so searching "pokemon" never matched a title spelled "Pokemon" with the accent EBTH itself uses
-- -- true of any accented word (cafe/cafe, Cezanne/Cezanne), not just this one. dash_unaccent is a
-- plain translate()-based fold, not the unaccent extension, since that extension isn't available
-- in every Postgres these migrations run against (this project's local test database included).
-- (2) classify_lot checked "japanese" and "ancient" before ever reaching the Pokemon/trading-card
-- rule, so "Nine CGC Graded Japanese Pokemon Cards" landed in Asian art and "Pokemon Cards
-- Featuring Ancient Mew Promo" landed in Antiquities -- a dedicated early check fixes both.
create or replace function dash_unaccent(t text) returns text
language sql immutable as $$
  select translate(t, 'áàâäãåāăąÁÀÂÄÃÅĀĂĄéèêëēĕėęěÉÈÊËĒĔĖĘĚíìîïĩīĭįÍÌÎÏĨĪĬĮóòôöõøōŏőÓÒÔÖÕØŌŎŐúùûüũūŭůűųÚÙÛÜŨŪŬŮŰŲýÿŷÝŸŶñńņňÑŃŅŇçćĉċčÇĆĈĊČß', 'aaaaaaaaaAAAAAAAAAeeeeeeeeeEEEEEEEEEiiiiiiiiIIIIIIIIoooooooooOOOOOOOOOuuuuuuuuuuUUUUUUUUUUyyyYYYnnnnNNNNcccccCCCCCs');
$$;

create or replace function dash_search(p_token text, p jsonb default '{}'::jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_terms text[] := array(select t from unnest(regexp_split_to_array(lower(trim(coalesce(p->>'q', ''))), '\s+')) t where t <> '');
  v_status text := coalesce(nullif(p->>'status', ''), 'open');
  v_sort_raw text := coalesce(nullif(p->>'sort', ''), 'ends');
  v_key text := case v_sort_raw when 'bid_asc' then 'bid' when 'bid_desc' then 'bid'
                  when 'estimate' then 'worst' when 'gap' then 'worst_gap' when 'room' then 'worst_room' when 'max' then 'worst_room'
                  else v_sort_raw end;
  v_dir text := case when p->>'dir' in ('asc', 'desc') then p->>'dir'
                     when v_sort_raw = 'bid_asc' then 'asc'
                     when v_sort_raw in ('ends', 'name', 'category') then 'asc'
                     else 'desc' end;
  v_est text := coalesce(nullif(p->>'estimate', ''), 'any');
  v_sale text := nullif(p->>'sale', '');
  v_cat text := nullif(p->>'category', '');
  v_cats text[] := case when jsonb_typeof(p->'categories') = 'array' then array(select jsonb_array_elements_text(p->'categories')) else null end;
  v_min numeric := nullif(p->>'min_bid', '')::numeric;
  v_max numeric := nullif(p->>'max_bid', '')::numeric;
  v_within numeric := nullif(p->>'within_hours', '')::numeric;
  v_tracked boolean := coalesce(nullif(p->>'tracked', '')::boolean, false);
  v_starred boolean := coalesce(nullif(p->>'starred', '')::boolean, false);
  v_limit int := least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200);
  v_offset int := greatest(coalesce(nullif(p->>'offset', '')::int, 0), 0);
  v_prem numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25);
  v_disc numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15);
  v_marg numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           coalesce(e.est_low, e.est_high) as v_worst, base_case(e.est_low, e.est_high) as v_base, coalesce(e.est_high, e.est_low) as v_best,
           round(coalesce(e.est_low, e.est_high) * (1 - v_disc)) as v_dealer,
           coalesce(l.min_next_bid, coalesce(l.high_bid, 0) + 1) as next_bid
      from lot_latest l left join lots lo on lo.item_id = l.item_id
           left join lot_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
       and (v_within is null or (l.ends_at > p_now and l.ends_at <= p_now + make_interval(secs => v_within * 3600)))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (not v_tracked or l.tracked)
       and (not v_starred or l.starred)
       and (v_sale is null or l.sale_id = v_sale)
       and (v_cat is null or lo.category = v_cat)
       and (v_cats is null or lo.category = any(v_cats))
       and not exists (select 1 from unnest(v_terms) t
                        where position(dash_unaccent(t) in dash_unaccent(lower(coalesce(l.name, '') || ' ' || coalesce(e.notes, '')))) = 0)
  ), calc as (
    select b.*,
           suggested_max_bid(b.v_worst) as max_worst, suggested_max_bid(b.v_base) as max_base, suggested_max_bid(b.v_best) as max_best,
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst, (b.v_base - coalesce(b.high_bid, 0)) as gap_base, (b.v_best - coalesce(b.high_bid, 0)) as gap_best,
           (b.v_dealer - coalesce(b.high_bid, 0)) as gap_dealer,
           floor(b.v_dealer * (1 - v_marg) / (1 + v_prem)) as max_dealer,
           (b.v_worst - resale_fee(b.v_worst)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_worst,
           (b.v_base - resale_fee(b.v_base)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_base,
           (b.v_best - resale_fee(b.v_best)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_best,
           b.v_dealer - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_dealer
      from base b
  ), rooms as (
    select c.*, (c.max_worst - c.next_bid) as room_worst, (c.max_base - c.next_bid) as room_base, (c.max_best - c.next_bid) as room_best, (c.max_dealer - c.next_bid) as room_dealer,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_worst / (c.high_bid * (1 + v_prem)) end as roi_worst,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_base / (c.high_bid * (1 + v_prem)) end as roi_base,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_best / (c.high_bid * (1 + v_prem)) end as roi_best,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_dealer / (c.high_bid * (1 + v_prem)) end as roi_dealer
      from calc c
  ), ranked as (
    select b.*, count(*) over () as total,
           row_number() over (order by
             case when v_key = 'ends' and v_dir = 'asc' then b.ends_at end asc nulls last,
             case when v_key = 'ends' and v_dir = 'desc' then b.ends_at end desc nulls last,
             case when v_key = 'bid' and v_dir = 'asc' then b.high_bid end asc nulls last,
             case when v_key = 'bid' and v_dir = 'desc' then b.high_bid end desc nulls last,
             case when v_key = 'bids' and v_dir = 'asc' then b.bids_count end asc nulls last,
             case when v_key = 'bids' and v_dir = 'desc' then b.bids_count end desc nulls last,
             case when v_key = 'bidders' and v_dir = 'asc' then b.unique_bidders end asc nulls last,
             case when v_key = 'bidders' and v_dir = 'desc' then b.unique_bidders end desc nulls last,
             case when v_key = 'source' and v_dir = 'asc' then b.est_updated end asc nulls last,
             case when v_key = 'source' and v_dir = 'desc' then b.est_updated end desc nulls last,
             case when v_key = 'name' and v_dir = 'asc' then lower(b.name) end asc nulls last,
             case when v_key = 'name' and v_dir = 'desc' then lower(b.name) end desc nulls last,
             case when v_key = 'category' and v_dir = 'asc' then lower(b.category) end asc nulls last,
             case when v_key = 'category' and v_dir = 'desc' then lower(b.category) end desc nulls last,
             case when v_key = 'seen' and v_dir = 'asc' then b.snapshot_ts end asc nulls last,
             case when v_key = 'seen' and v_dir = 'desc' then b.snapshot_ts end desc nulls last,
             case when v_key = 'worst' and v_dir = 'asc' then b.v_worst end asc nulls last,
             case when v_key = 'worst' and v_dir = 'desc' then b.v_worst end desc nulls last,
             case when v_key = 'worst_gap' and v_dir = 'asc' then b.gap_worst end asc nulls last,
             case when v_key = 'worst_gap' and v_dir = 'desc' then b.gap_worst end desc nulls last,
             case when v_key = 'worst_room' and v_dir = 'asc' then b.room_worst end asc nulls last,
             case when v_key = 'worst_room' and v_dir = 'desc' then b.room_worst end desc nulls last,
             case when v_key = 'base' and v_dir = 'asc' then b.v_base end asc nulls last,
             case when v_key = 'base' and v_dir = 'desc' then b.v_base end desc nulls last,
             case when v_key = 'base_gap' and v_dir = 'asc' then b.gap_base end asc nulls last,
             case when v_key = 'base_gap' and v_dir = 'desc' then b.gap_base end desc nulls last,
             case when v_key = 'base_room' and v_dir = 'asc' then b.room_base end asc nulls last,
             case when v_key = 'base_room' and v_dir = 'desc' then b.room_base end desc nulls last,
             case when v_key = 'best' and v_dir = 'asc' then b.v_best end asc nulls last,
             case when v_key = 'best' and v_dir = 'desc' then b.v_best end desc nulls last,
             case when v_key = 'best_gap' and v_dir = 'asc' then b.gap_best end asc nulls last,
             case when v_key = 'best_gap' and v_dir = 'desc' then b.gap_best end desc nulls last,
             case when v_key = 'best_room' and v_dir = 'asc' then b.room_best end asc nulls last,
             case when v_key = 'best_room' and v_dir = 'desc' then b.room_best end desc nulls last,
             case when v_key = 'worst_roi' and v_dir = 'asc' then b.roi_worst end asc nulls last,
             case when v_key = 'worst_roi' and v_dir = 'desc' then b.roi_worst end desc nulls last,
             case when v_key = 'base_roi' and v_dir = 'asc' then b.roi_base end asc nulls last,
             case when v_key = 'base_roi' and v_dir = 'desc' then b.roi_base end desc nulls last,
             case when v_key = 'best_roi' and v_dir = 'asc' then b.roi_best end asc nulls last,
             case when v_key = 'best_roi' and v_dir = 'desc' then b.roi_best end desc nulls last,
             case when v_key = 'dealer' and v_dir = 'asc' then b.v_dealer end asc nulls last,
             case when v_key = 'dealer' and v_dir = 'desc' then b.v_dealer end desc nulls last,
             case when v_key = 'dealer_gap' and v_dir = 'asc' then b.gap_dealer end asc nulls last,
             case when v_key = 'dealer_gap' and v_dir = 'desc' then b.gap_dealer end desc nulls last,
             case when v_key = 'dealer_room' and v_dir = 'asc' then b.room_dealer end asc nulls last,
             case when v_key = 'dealer_room' and v_dir = 'desc' then b.room_dealer end desc nulls last,
             case when v_key = 'dealer_roi' and v_dir = 'asc' then b.roi_dealer end asc nulls last,
             case when v_key = 'dealer_roi' and v_dir = 'desc' then b.roi_dealer end desc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from rooms b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'next_bid' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_key, 'dir', v_dir, 'rows', v_rows);
end $$;

create or replace function classify_lot(p_name text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare n text := lower(coalesce(p_name, ''));
  karat boolean;
begin
  if n = '' then return null; end if;
  if n ~ '\ypok[eé]mon\y' then return 'Collectibles and memorabilia'; end if;
  if n ~ '\y(napkin|key|curtain|teething|pull) rings?\y|\yring toss\y' then return 'Kitchen and household'; end if;
  if n ~ '\ylab[- ]?(grown|created|made)\y|\ymoissanite\y' then return 'Lab-grown stones and jewelry'; end if;
  if n ~ '\y(watch )?fobs?\y|\ywatch chains?\y' and n !~ '\y(pocket|wrist) ?watch(es)?\y' then
    if n ~ '\y(sterling|925|coin silver|silver(?![- ]?(tone|plate|plated)))\y|\.925' then return 'Jewelry, silver'; end if;
    if n ~ '^.{0,28}\y(10|14|18|22|24)\s?k(t)?\y' or n ~ '\ygold\y(?![- ](filled|plated|tone))' then return 'Jewelry, gold'; end if;
    return 'Jewelry, other';
  end if;
  if n ~ '\ywatch(es)?\y|\ywristwatch\y|\ychronograph\y|\y(rolex|omega|patek|breitling|tag heuer|seiko|movado|bulova|longines|tissot|audemars|vacheron|panerai|hublot|swatch)\y' then return 'Watches'; end if;
  if n ~ '\y(lamps?|chandeliers?|sconces?|lanterns?|torchi[eè]res?|lampshades?|prisms?|bobeches|light fixtures?|ceiling lights?|wall lights?|pendant (light|lamp|fixture))\y|\ylighting\y' then return 'Lighting'; end if;
  if n ~ '^loose\y' then return 'Loose stones'; end if;
  karat := n ~ '^.{0,28}\y(10|14|18|22|24)\s?k(t)?\y' and n !~ '\y(with|and|w/|featuring)\s+(10|14|18|22|24)\s?k(t)?\y';
  if n ~ '\y(rings?|bracelets?|bangles?|cuffs?|necklaces?|pendants?|earrings?|brooch(es)?|lockets?|chokers?|anklets?|cufflinks?|bolos?|concho|squash blossom|bands?|charms?|lapel pins?|stick pins?|hat pins?|tie (pin|tack|bar|clip))\y|\yjewel(le)?ry\y(?! (box|boxes|case|chest|holder|stand|tray|armoire))' then
    if n ~ '\y(navajo|din[eé]|zuni|hopi|santo domingo|pueblo|southwestern|western|squash blossom|bolo|concho|gaspeite|spiny oyster|magnesite|turquoise|native american)\y' and not karat then return 'Jewelry, Southwest'; end if;
    if n ~ '\y(sterling|925|coin silver|silver(?![- ]?(tone|plate|plated)))\y|\.925' then return 'Jewelry, silver'; end if;
    if karat or n ~ '\ygold\y(?![- ](filled|plated|tone))' then return 'Jewelry, gold'; end if;
    return 'Jewelry, other';
  end if;
  if n ~ '\y(paintings?|watercolou?rs?|gouache|lithographs?|chromolithographs?|serigraphs?|gicl[eé]es?|etchings?|engravings?|woodcuts?|linocuts?|screen ?prints?|silkscreens?|drawings?|pastels?|charcoal|collages?|assemblages?|sculptures?|carvings?|mixed media|oil portrait|photographs?|mezzotint|aquatint|monotype|art print|giclee print|signed print|framed prints?|botanical prints?|prints? by|print of|original art|busts?|halftones?|rotogravures?|woodblocks?|monoprints?|prints|graphic prints?|embellished prints?|digital prints?|oil on (canvas|paper|board|panel|paperboard)|oil landscape|gesso|illustrations?|sgraffito|abstract|floral compositions?|triptychs?|retablos?|acrylic portrait|cartoon|sketch(es)?|studies|hand-colored)\y' then return 'Art'; end if;
  if n ~ '\y(handbags?|purses?|totes?|crossbody|clutch(es)?|satchels?|shoulder bags?|messenger|backpacks?|wallets?|luggage|keepall|speedy|neverfull|scarf|scarves|belts?|sunglasses|eyeglasses|hats?|caps?|coats?|jackets?|dress(es)?|blouses?|shirts?|skirts?|pants|sweaters?|robes?|puffers?|sneakers?|shoes?|boots?|loafers?|gloves?|ties?|cloche|bags?|cardigans?|capelets?|capes?|jeans|denim|turtlenecks?|vests?|tunics?|trousers|blazers?|gowns?|shawls?|pumps|heels|sandals|slippers|mules|leggings|fur)\y|\y(louis vuitton|gucci|chanel|herm[eè]s|prada|fendi|burberry|coach|chlo[eé]|dior|c[eé]line|bottega|saint laurent|balenciaga|kate spade|michael kors|tory burch|ferragamo|goyard|mulberry|longchamp|loewe|valentino|dooney|pucci|mcm|stetson|allen edmonds|dolce (&|and) gabbana|stella mccartney|manolo blahnik|jimmy choo|louboutin|banana republic|paige|per se|armani|versace|ralph lauren|brooks brothers)\y' then return 'Handbags and fashion'; end if;
  if n ~ '\y(walking sticks?|walking canes?|canes?)\y' then return 'Collectibles and memorabilia'; end if;
  if n ~ '\y(stamps?|philatelic|airmail|cachets?|postal covers?|first day covers?|postal|stationery|stamped)\y|\yscott c?\d' then return 'Stamps'; end if;
  if n ~ '\y(coins?(?!\s+(silver|banks?))|denarius|drachm|tetradrachm|dinar|sestertius|bullion|numismatic|banknotes?|currency|silver dollars?|morgan dollars?|peace dollars?|balboa|proof sets?|mint sets?|penny|pennies|silver eagle|gold eagle|nickels?|dimes?|cents?|tokens?|medals?|half crowns?|florins?|shillings?|sixpence|farthings?|thalers?|sovereigns?)\y' then return 'Coins and currency'; end if;
  if n ~ '^[\"“][^\"”]+[\"”] by\s|^signed\s+[\"“‘].{1,120}[\"”’]\s+by\s|\y((?<!faux )books?|first editions?|cookbooks?|manuscripts?|atlas|maps?|ephemera|postcards?|posters?|magazines?|newspapers?|documents?|letters?|bibles?|volumes?|encyclopedia|almanac|broadsides?|deeds?|certificates?|catalogs?|catalogues?|poetical works|collected works|folios?)\y' then return 'Books, maps and ephemera'; end if;
  if n ~ '\y(ancient|antiquit(y|ies)|pre-?columbian|protoclassic|egyptian|roman era|byzantine|etruscan|mesopotamian|sumerian|neolithic|paleolithic|fossils?|meteorites?|megalodon|trilobite|mammoth|artifacts?|mummy|scarab|votive|terracotta|shabti|taxidermy|antlers?|skulls?|geodes?|specimens?|arrowheads?|knapped|projectile points?)\y' then return 'Antiquities and natural history'; end if;
  if n ~ '\y(rugs?|carpets?|kilims?|tapestr(y|ies)|quilts?|textiles?|runners?|dhurries|dhurrie|needlepoint|embroider(y|ed)|macram[eé]|weavings?|throw pillows?|pillow covers?|pillowcases?|curtains?|draperies|drapes)\y' then return 'Rugs and textiles'; end if;
  if n ~ '\y(native american|navajo|din[eé]|hopi|zuni|pueblo|san ildefonso|acoma|santa clara|kachinas?|katsinas?|huichol|alebrijes?|folk art|tribal|indigenous|inuit|first nations|mola|oaxacan|taos|papua new guinea|aboriginal|african|oceanic|maori|beadwork|polynesian|aztec)\y' then return 'Native American, tribal and folk art'; end if;
  if n ~ '\yornaments?\y|\ychristmas tree\y' then return 'Decorative objects'; end if;
  if n ~ '\y(silver ?plate(d)?|silverplate(d)?|epns|plated)\y' then return 'Decorative objects'; end if;
  if n ~ '\y(sterling|925|coin silver|silver)\y|\.925' then return 'Sterling and silver'; end if;
  if n ~ '\y(tables?|chairs?|armchairs?|stools?|barstools?|sofas?|couch(es)?|settees?|loveseats?|bench(es)?|cabinets?|dressers?|chests?|desks?|bookcases?|credenzas?|sideboards?|armoires?|nightstands?|beds?|headboards?|(?<!antique )ottomans?|mirrors?|[eé]tag[eè]res?|buffets?|shelves|shelf|hutch(es)?|wardrobes?|secretaires?|screens?|pedestals?|recliners?|rockers?|chaises?|bar carts?|vanit(y|ies)|trunks?|daybeds?|cribs?|highboards?|lowboards?|commodes?|tallboys?|whatnots?|plant stands?|coat racks?|umbrella stands?|fauteuils?|poufs?|gliders?|carts?|library steps|curule)\y' then return 'Furniture'; end if;
  if n ~ '\y(pottery|porcelain|ceramics?|earthenware|stoneware|faience|vases?|pitchers?|plates?|bowls?|platters?|tureens?|teapots?|tea sets?|dinnerware|china|crystal|glassware|stemware|decanters?|tumblers?|wine glasses|(martini|highball|shot|drinking|water|cocktail|champagne|whiskey|rocks|bar) glasses|goblets?|snifters?|flutes?|cordials?|carafes?|murano|baccarat|lalique|waterford|steuben|lenox|herend|meissen|doulton|wedgwood|spode|rookwood|pewabic|noritake|majolica|delft|s[eè]vres|limoges|vista alegre|fitz and floyd|franciscan|haviland|art glass|blown glass|cut glass|tiles?|urns?|mugs?|cups?|saucers?|ramekins?|jugs?|iznik|bisque)\y|\yglass\y(?! top)' then return 'Ceramics and glass'; end if;
  if n ~ '\y(chinese|japanese|tibetan|korean|thai|burmese|nepalese|himalayan|mughal|jade|cloisonn[eé]|netsuke|satsuma|imari|kutani|buddhas?|buddhist|hindu|ming|qing|kangxi|qianlong|samurai|kimono|geisha|oriental|asian|indonesian|balinese|vietnamese|khmer|chinoiserie|scroll)\y' then return 'Asian art'; end if;
  if n ~ '\y(cards?|trading|baseball|basketball|football|hockey|nba|nfl|mlb|nhl|bobbleheads?|beanie|barbie|dolls?|toys?|lego|funko|pok[eé]mon|star wars|comics?|memorabilia|autographs?|signed|jerseys?|records?|vinyl|lps?|hot wheels|matchbox|model trains?|trains?|locomotive|action figures?|puzzles?|games?|marbles|fountain pens?|montblanc|pen sets?|collectibles?|scorecards?|pennants?|snow globes?|cabbage patch|teddy|steiff|hummel|precious moments|lionel|die-?cast|banks?|kites?|chess|chessboards?|bowling balls?|video games?|ubisoft|nintendo|playstation|xbox|trophy|trophies|model (planes?|ships?|cars?|kits?)|scale models?)\y' then return 'Collectibles and memorabilia'; end if;
  if n ~ '\y(cameras?|lens(es)?|leica|nikon|canon|konica|olympus|exakta|minolta|pentax|polaroid|binoculars?|telescopes?|microscopes?|guitars?|pianos?|violins?|banjos?|saxophones?|trumpets?|clarinets?|amplifiers?|amps?|speakers?|stereo|turntables?|receivers?|radios?|televisions?|tv|computers?|laptops?|phones?|typewriters?|samsung|onkyo|sony|bose|marantz|pioneer|kenwood|technics|ukuleles?|drums?|synthesizers?|keyboards?|headphones?|sewing machines?|calculators?|telephones?|routers?|wi-?fi|netgear|modems?|darkroom|photography equipment|enlargers?|tripods?)\y' then return 'Cameras, music and electronics'; end if;
  if n ~ '\y(knives|knife|sabers?|swords?|axes?|hatchets?|saws?|wrenches|wrench|drills?|hammers?|fishing|rods?|reels?|bicycles?|golf|skis?|snowshoes?|tents?|paddles?|oars|buoys?|lobster|helmets?|uniforms?|militaria|military|army|navy|canteens?|bayonets?|scopes?|archery|bows?|arrows?|kayaks?|camping|hunting|decoys?|tackle|sleds?|skates?|rifle|pistol|holster|cutlery|lacrosse|cricket|bats?|dumbbells?|juggling|clubs?|cruisers?|bikes?|power tools?|tool kits?|shop vac|vacuums?)\y' then return 'Tools, sporting and military'; end if;
  if n ~ '\y(cookware|pans?|pots?|skillets?|kettles?|le creuset|utensils?|towels?|aprons?|linens?|napkins?|tablecloths?|placemats?|bedding|pillows?|blankets?|ladders?|tubs?|buckets?|brooms?|mops?|appliances?|mixers?|blenders?|toasters?|coffee makers?|dishes|dish|silverware|flatware|tupperware|pyrex|kitchen|kitchenware|colanders?|baking|bakeware|molds?|jars?|canisters?|thermos|coolers?|slicers?|graters?|peelers?|bread)\y' then return 'Kitchen and household'; end if;
  if n ~ '\y(figurines?|figures?|statues?|statuettes?|clocks?|candlesticks?|candle holders?|candelabras?|candelabrum|boxes|box|frames?|bookends?|brass|bronze|bronzed|copper|pewter|iron|planters?|baskets?|globes?|barware|cocktail|ornaments?|bells?|paperweights?|music boxes?|centerpieces?|trays?|chargers?|andirons?|fireplace|mantel|santa|christmas|holiday|d[eé]cor|decorative|wall hangings?|wreath|nativity|menorah|icons?|crosses|crucifix|medallions?|plaques?|masks?|birdhouses?|sundials?|weathervanes?|garden|fountain|topiary|trivets?|coasters?|serving|lazy susan|cachepots?|jardini[eè]res?|vessels?|amphora|spittoon|inkwells?|inkstands?|desk sets?|letter openers?|pipes?|cigar|humidors?|lighters?|ashtrays?|flasks?|steins?|tankards?|enamel|enameled|gilt|gilded|nutcrackers?|barometers?|scales?|thermometers?|compass(es)?|sextants?|flags?|barrels?|lawn|jockeys?|mannequins?|soapstone|alabaster|calcite|onyx|marble|jesus|madonna|saints?|santos|reliquary)\y' then return 'Decorative objects'; end if;
  if n ~ '\y(assorted|assortment|collection|group|lot|lots|variety|miscellaneous|grab bag|and more|with more|and other|with other|and additional)\y' then return 'Mixed lots'; end if;
  return 'Other';
end $$;

update lots set category = classify_lot(name)
 where category in ('Asian art', 'Antiquities and natural history') and name ilike '%pok%mon%';
