#!/usr/bin/env python3
"""Generates the classify_lot() SQL function from the ordered rule list below.
Order matters: the first rule that matches wins. Regexes are Postgres ARE, matched against the lower-cased title."""
import sys

R = {}
R["napkin"]  = r"\y(napkin|key|curtain|teething|pull) rings?\y|\yring toss\y"
R["lab"]     = r"\ylab[- ]?(grown|created|made)\y|\ymoissanite\y"
R["watch"]   = r"\ywatch(es)?\y|\ywristwatch\y|\ychronograph\y|\y(rolex|omega|patek|breitling|tag heuer|seiko|movado|bulova|longines|tissot|audemars|vacheron|panerai|hublot|swatch)\y"
R["fob"]     = r"\y(watch )?fobs?\y|\ywatch chains?\y"
R["realwatch"] = r"\y(pocket|wrist) ?watch(es)?\y"
R["light"]   = r"\y(lamps?|chandeliers?|sconces?|lanterns?|torchi[eè]res?|lampshades?|prisms?|bobeches|light fixtures?|pendant (light|lamp|fixture))\y|\ylighting\y"
R["loose"]   = r"^loose\y"
R["jew"]     = r"\y(rings?|bracelets?|bangles?|cuffs?|necklaces?|pendants?|earrings?|brooch(es)?|lockets?|chokers?|anklets?|cufflinks?|bolos?|concho|squash blossom|bands?|charms?|lapel pins?|stick pins?|hat pins?|tie (pin|tack|bar|clip))\y|\yjewel(le)?ry\y(?! (box|boxes|case|chest|holder|stand|tray|armoire))"
R["sw"]      = r"\y(navajo|din[eé]|zuni|hopi|santo domingo|pueblo|southwestern|western|squash blossom|bolo|concho|gaspeite|spiny oyster|magnesite|turquoise|native american)\y"
R["karat"]   = r"^.{0,28}\y(10|14|18|22|24)\s?k(t)?\y"
R["sterling"]= r"\y(sterling|925|coin silver|silver(?![- ]?(tone|plate|plated)))\y|\.925"
R["gold"]    = r"\ygold\y(?![- ](filled|plated|tone))"
R["art"]     = r"\y(paintings?|watercolou?rs?|gouache|lithographs?|chromolithographs?|serigraphs?|gicl[eé]es?|etchings?|engravings?|woodcuts?|linocuts?|screen ?prints?|silkscreens?|drawings?|pastels?|charcoal|collages?|assemblages?|sculptures?|carvings?|mixed media|oil portrait|photographs?|mezzotint|aquatint|monotype|art print|giclee print|signed print|framed prints?|botanical prints?|prints? by|print of|original art|busts?|halftones?|rotogravures?|woodblocks?|monoprints?|prints|graphic prints?|embellished prints?|digital prints?|oil on (canvas|paper|board|panel|paperboard)|oil landscape|gesso|illustrations?|sgraffito|abstract|floral compositions?|triptychs?|retablos?|acrylic portrait|cartoon|sketch(es)?|studies|hand-colored)\y"
R["fashion"] = r"\y(handbags?|purses?|totes?|crossbody|clutch(es)?|satchels?|shoulder bags?|messenger|backpacks?|wallets?|luggage|keepall|speedy|neverfull|scarf|scarves|belts?|sunglasses|eyeglasses|hats?|caps?|coats?|jackets?|dress(es)?|blouses?|shirts?|skirts?|pants|sweaters?|robes?|puffers?|sneakers?|shoes?|boots?|loafers?|gloves?|ties?|cloche|bags?|cardigans?|capelets?|capes?|jeans|denim|turtlenecks?|vests?|tunics?|trousers|blazers?|gowns?|shawls?|pumps|heels|sandals|slippers|mules|leggings|fur)\y|\y(louis vuitton|gucci|chanel|herm[eè]s|prada|fendi|burberry|coach|chlo[eé]|dior|c[eé]line|bottega|saint laurent|balenciaga|kate spade|michael kors|tory burch|ferragamo|goyard|mulberry|longchamp|loewe|valentino|dooney|pucci|mcm|stetson|allen edmonds|dolce (&|and) gabbana|stella mccartney|manolo blahnik|jimmy choo|louboutin|banana republic|paige|per se|armani|versace|ralph lauren|brooks brothers)\y"
R["stamps"]  = r"\y(stamps?|philatelic|airmail|cachets?|postal covers?|first day covers?|postal|stationery|stamped)\y|\yscott c?\d"
R["coinscur"]= r"\y(coins?|denarius|drachm|tetradrachm|dinar|sestertius|bullion|numismatic|banknotes?|currency|silver dollars?|morgan dollars?|peace dollars?|balboa|proof sets?|mint sets?|penny|pennies|silver eagle|gold eagle|nickels?|dimes?|cents?|tokens?|medals?|half crowns?|florins?|shillings?|sixpence|farthings?|thalers?|sovereigns?)\y"
R["books"]   = r"^[\"“][^\"”]+[\"”] by\s|^signed\s+[\"“‘].{1,120}[\"”’]\s+by\s|\y((?<!faux )books?|first editions?|cookbooks?|manuscripts?|atlas|maps?|ephemera|postcards?|posters?|magazines?|newspapers?|documents?|letters?|bibles?|volumes?|encyclopedia|almanac|broadsides?|deeds?|certificates?|catalogs?|catalogues?|poetical works|collected works|folios?)\y"
R["antiq"]   = r"\y(ancient|antiquit(y|ies)|pre-?columbian|protoclassic|egyptian|roman era|byzantine|etruscan|mesopotamian|sumerian|neolithic|paleolithic|fossils?|meteorites?|megalodon|trilobite|mammoth|artifacts?|mummy|scarab|votive|terracotta|shabti|taxidermy|antlers?|skulls?|geodes?|specimens?|arrowheads?|knapped|projectile points?)\y"
R["native"]  = r"\y(native american|navajo|din[eé]|hopi|zuni|pueblo|san ildefonso|acoma|santa clara|kachinas?|katsinas?|huichol|alebrijes?|folk art|tribal|indigenous|inuit|first nations|mola|oaxacan|taos|papua new guinea|aboriginal|african|oceanic|maori|beadwork|polynesian|aztec)\y"
R["rugs"]    = r"\y(rugs?|carpets?|kilims?|tapestr(y|ies)|quilts?|textiles?|runners?|dhurries|dhurrie|needlepoint|embroider(y|ed)|macram[eé]|weavings?|throw pillows?|pillow covers?|pillowcases?|curtains?|draperies|drapes)\y"
R["plated"]  = r"\y(silver ?plate(d)?|silverplate(d)?|epns|plated)\y"
R["silver"]  = r"\y(sterling|925|coin silver|silver)\y|\.925"
R["ceram"]   = r"\y(pottery|porcelain|ceramics?|earthenware|stoneware|faience|vases?|pitchers?|plates?|bowls?|platters?|tureens?|teapots?|tea sets?|dinnerware|china|crystal|glassware|stemware|decanters?|tumblers?|wine glasses|(martini|highball|shot|drinking|water|cocktail|champagne|whiskey|rocks|bar) glasses|goblets?|snifters?|flutes?|cordials?|carafes?|murano|baccarat|lalique|waterford|steuben|lenox|herend|meissen|doulton|wedgwood|spode|rookwood|pewabic|noritake|majolica|delft|s[eè]vres|limoges|vista alegre|fitz and floyd|franciscan|haviland|art glass|blown glass|cut glass|tiles?|urns?|mugs?|cups?|saucers?|ramekins?|jugs?|iznik|bisque)\y|\yglass\y(?! top)"
R["asian"]   = r"\y(chinese|japanese|tibetan|korean|thai|burmese|nepalese|himalayan|mughal|jade|cloisonn[eé]|netsuke|satsuma|imari|kutani|buddhas?|buddhist|hindu|ming|qing|kangxi|qianlong|samurai|kimono|geisha|oriental|asian|indonesian|balinese|vietnamese|khmer|chinoiserie|scroll)\y"
R["coll"]    = r"\y(cards?|trading|baseball|basketball|football|hockey|nba|nfl|mlb|nhl|bobbleheads?|beanie|barbie|dolls?|toys?|lego|funko|pok[eé]mon|star wars|comics?|memorabilia|autographs?|signed|jerseys?|records?|vinyl|lps?|hot wheels|matchbox|model trains?|trains?|locomotive|action figures?|puzzles?|games?|marbles|fountain pens?|montblanc|pen sets?|collectibles?|scorecards?|pennants?|snow globes?|cabbage patch|teddy|steiff|hummel|precious moments|lionel|die-?cast|banks?|kites?|chess|chessboards?|bowling balls?|video games?|ubisoft|nintendo|playstation|xbox|trophy|trophies|model (planes?|ships?|cars?|kits?)|scale models?)\y"
R["elec"]    = r"\y(cameras?|lens(es)?|leica|nikon|canon|konica|olympus|exakta|minolta|pentax|polaroid|binoculars?|telescopes?|microscopes?|guitars?|pianos?|violins?|banjos?|saxophones?|trumpets?|clarinets?|amplifiers?|amps?|speakers?|stereo|turntables?|receivers?|radios?|televisions?|tv|computers?|laptops?|phones?|typewriters?|samsung|onkyo|sony|bose|marantz|pioneer|kenwood|technics|ukuleles?|drums?|synthesizers?|keyboards?|headphones?|sewing machines?|calculators?|telephones?|routers?|wi-?fi|netgear|modems?|darkroom|photography equipment|enlargers?|tripods?)\y"
R["furn"]    = r"\y(tables?|chairs?|armchairs?|stools?|barstools?|sofas?|couch(es)?|settees?|loveseats?|bench(es)?|cabinets?|dressers?|chests?|desks?|bookcases?|credenzas?|sideboards?|armoires?|nightstands?|beds?|headboards?|(?<!antique )ottomans?|mirrors?|[eé]tag[eè]res?|buffets?|shelves|shelf|hutch(es)?|wardrobes?|secretaires?|screens?|pedestals?|recliners?|rockers?|chaises?|bar carts?|vanit(y|ies)|trunks?|daybeds?|cribs?|highboards?|lowboards?|commodes?|tallboys?|whatnots?|plant stands?|coat racks?|umbrella stands?|fauteuils?|poufs?|gliders?|carts?|library steps|curule)\y"
R["tools"]    = r"\y(knives|knife|sabers?|swords?|axes?|hatchets?|saws?|wrenches|wrench|drills?|hammers?|fishing|rods?|reels?|bicycles?|golf|skis?|snowshoes?|tents?|paddles?|oars|buoys?|lobster|helmets?|uniforms?|militaria|military|army|navy|canteens?|bayonets?|scopes?|archery|bows?|arrows?|kayaks?|camping|hunting|decoys?|tackle|sleds?|skates?|rifle|pistol|holster|cutlery|lacrosse|cricket|bats?|dumbbells?|juggling|clubs?|cruisers?|bikes?|power tools?|tool kits?|shop vac|vacuums?)\y"
R["house"]   = r"\y(cookware|pans?|pots?|skillets?|kettles?|le creuset|utensils?|towels?|aprons?|linens?|napkins?|tablecloths?|placemats?|bedding|pillows?|blankets?|ladders?|tubs?|buckets?|brooms?|mops?|appliances?|mixers?|blenders?|toasters?|coffee makers?|dishes|dish|silverware|flatware|tupperware|pyrex|kitchen|kitchenware|colanders?|baking|bakeware|molds?|jars?|canisters?|thermos|coolers?|slicers?|graters?|peelers?|bread)\y"
R["decor"]   = r"\y(figurines?|figures?|statues?|statuettes?|clocks?|candlesticks?|candle holders?|candelabras?|candelabrum|boxes|box|frames?|bookends?|brass|bronze|bronzed|copper|pewter|iron|planters?|baskets?|globes?|barware|cocktail|ornaments?|bells?|paperweights?|music boxes?|centerpieces?|trays?|chargers?|andirons?|fireplace|mantel|santa|christmas|holiday|d[eé]cor|decorative|wall hangings?|wreath|nativity|menorah|icons?|crosses|crucifix|medallions?|plaques?|masks?|birdhouses?|sundials?|weathervanes?|garden|fountain|topiary|trivets?|coasters?|serving|lazy susan|cachepots?|jardini[eè]res?|vessels?|amphora|spittoon|inkwells?|inkstands?|desk sets?|letter openers?|pipes?|cigar|humidors?|lighters?|ashtrays?|flasks?|steins?|tankards?|enamel|enameled|gilt|gilded|nutcrackers?|barometers?|scales?|thermometers?|compass(es)?|sextants?|flags?|barrels?|lawn|jockeys?|mannequins?|soapstone|alabaster|calcite|onyx|marble|jesus|madonna|saints?|santos|reliquary)\y"
R["canes"]   = r"\y(walking sticks?|walking canes?|canes?)\y"
R["ornament"]= r"\yornaments?\y|\ychristmas tree\y"
R["with_karat"] = r"\y(with|and|w/|featuring)\s+(10|14|18|22|24)\s?k(t)?\y"
R["mixed"]   = r"\y(assorted|assortment|collection|group|lot|lots|variety|miscellaneous|grab bag|and more|with more|and other|with other|and additional)\y"

def q(s): return s.replace("'", "''")

def build():
    lines = []
    def rule(key, cat): lines.append(f"  if n ~ '{q(R[key])}' then return '{cat}'; end if;")
    rule("napkin", "Kitchen and household")
    rule("lab", "Lab-grown stones and jewelry")
    # a fob or a watch chain is jewelry, unless the title says it is a pocket watch or wristwatch
    lines.append(f"  if n ~ '{q(R['fob'])}' and n !~ '{q(R['realwatch'])}' then")
    lines.append(f"    if n ~ '{q(R['sterling'])}' then return 'Jewelry, silver'; end if;")
    lines.append(f"    if n ~ '{q(R['karat'])}' or n ~ '{q(R['gold'])}' then return 'Jewelry, gold'; end if;")
    lines.append(f"    return 'Jewelry, other';")
    lines.append(f"  end if;")
    rule("watch", "Watches")
    rule("light", "Lighting")
    rule("loose", "Loose stones")
    lines.append(f"  karat := n ~ '{q(R['karat'])}' and n !~ '{q(R['with_karat'])}';")
    lines.append(f"  if n ~ '{q(R['jew'])}' then")
    lines.append(f"    if n ~ '{q(R['sw'])}' and not karat then return 'Jewelry, Southwest'; end if;")
    lines.append(f"    if n ~ '{q(R['sterling'])}' then return 'Jewelry, silver'; end if;")
    lines.append(f"    if karat or n ~ '{q(R['gold'])}' then return 'Jewelry, gold'; end if;")
    lines.append(f"    return 'Jewelry, other';")
    lines.append(f"  end if;")
    for key, cat in [("art","Art"),("fashion","Handbags and fashion"),("stamps","Stamps"),("coinscur","Coins and currency"),
                     ("books","Books, maps and ephemera"),("antiq","Antiquities and natural history"),
                     ("rugs","Rugs and textiles"),("native","Native American, tribal and folk art"),
                     ("canes","Collectibles and memorabilia"),("ornament","Decorative objects"),("plated","Decorative objects"),("silver","Sterling and silver"),("furn","Furniture"),
                     ("ceram","Ceramics and glass"),("asian","Asian art"),
                     ("coll","Collectibles and memorabilia"),("elec","Cameras, music and electronics"),
                     ("tools","Tools, sporting and military"),
                     ("house","Kitchen and household"),("decor","Decorative objects"),("mixed","Mixed lots")]:
        rule(key, cat)
    body = "\n".join(lines)
    return f"""-- Sorts a lot title into one category. The first rule that matches wins, so the order matters.
-- Generated by tools/build_classifier.py; change the rules there and regenerate.
create or replace function classify_lot(p_name text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare n text := lower(coalesce(p_name, ''));
  karat boolean;
begin
  if n = '' then return null; end if;
{body}
  return 'Other';
end $$;
"""

if __name__ == "__main__":
    sys.stdout.write(build())
