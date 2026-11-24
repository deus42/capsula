import type { Category } from '../server/schema.ts';
import { brandKey } from './brand-sizes.ts';

interface Guide {
  title: string;
  url: string;
  categories: readonly Category[];
  columns: readonly string[];
  rows: string[][];
}

const tops = ['tees', 'shirts', 'knitwear', 'outerwear'] as const;
const bottoms = ['trousers', 'shorts'] as const;
const shoes = ['shoes'] as const;
const chest = 'Груди, см';
const waist = 'Талія, см';
const hips = 'Стегна, см';
const foot = 'Довжина стопи, см';
const size = 'Розмір';
const shoeColumns = ['EU', 'UK', 'US', foot];
const levis = 'https://www.levi.com/GB/en_GB/info/sizechart';
const scotch = 'https://www.scotchandsoda.com/pages/size-guide';

function guide(title: string, url: string, categories: readonly Category[], columns: readonly string[], values: string): Guide {
  return { title, url, categories, columns, rows: values.trim().split('\n').filter(Boolean).map((row) => row.trim().split(/\s+/)) };
}

/** Men's charts from the original brand pages, checked on 2026-11-24. Numbers keep the source's unit. */
const guides = new Map<string, Guide[]>([
  ['levis', [
    guide('Талія джинсів', levis, bottoms, ['W', waist, hips], `
      24 61 77.5
      25 63.5 80
      26 66 82.5
      27 68.6 85
      28 71.1 87.5
      29 73.7 90.2
      30 76.2 92.7
      31 78.7 95.3
      32 81.3 97.8
      33 83.8 100.3
      34 86.4 103
      35 89 105.5
      36 91.4 108
      38 96.5 113
      40 101.6 118
      42 106.7 123.2
      44 111.8 128.3
      46 116.7 133.5
      48 121.9 138.5
      50 127 143.5
      52 132 148.6
      54 137.2 153.7
      56 142.2 158.8
      58 147.2 163.8
      60 152.4 169
    `),
    guide('Довжина джинсів', levis, bottoms, ['L', 'Зріст, см'], `
      30 167.6–172.7
      32 172.7–182.8
      34 182.8–193
      36 193–198.1
      38 198.1–203.2
    `),
    guide('Верх', levis, tops, [size, chest, waist], `
      XS 81.3–86.4 66–71.1
      S 88.9–94 73.7–78.7
      M 96.5–101.6 81.3–86.4
      L 104.1–109.2 88.9–94
      XL 111.8–116.8 96.5–101.6
      XXL 119.4–124.5 104.1–109.2
      3XL 127–132.1 111.8–116.8
      4XL 137.2–142.2 122–127
      5XL 157.5–162.6 132.1–137.2
    `),
  ]],
  ['scotchandsoda', [
    guide('Верх', scotch, tops, [size, 'EU', chest, waist, hips], `
      S 46 92 78 92
      M 48 98 84 98
      L 50 104 90 104
      XL 52 110 96 110
      XXL 54 116 102 116
    `),
    guide('Штани', scotch, bottoms, ['W', 'EU', waist, hips], `
      28 46 77.5 91.5
      29 46 80 94
      30 48 82.5 96.5
      31 48 85 99
      32 50 87.5 101.5
      33 50 90 104
      34 52 92.5 106.5
      36 52 97.5 111.5
      38 54 102.5 116.5
    `),
  ]],
  ['napapijri', [
    guide('Поло Ealis', 'https://www.napapijri.com/en-ie/products/ealis-pique-short-sleeve-polo-shirt-np0a4h8bb9a', ['shirts'], [size, chest, waist, hips], `
      XS 88–92 78–82 86–90
      S 92–96 82–86 90–94
      M 96–100 86–90 94–98
      L 100–104 90–94 98–102
      XL 104–111 94–101 102–109
      XXL 111–118 101–108 109–116
      3XL 118–125 108–115 116–123
    `),
  ]],
  ['poloralphlauren', [
    guide('Сорочки й поло', 'https://www.ralphlauren.com/size-guide/size-guide.html', ['shirts', 'tees'], [size, chest, waist], `
      XS 78.7–86.4 66–71.1
      S 88.9–94 71.1–76.2
      M 96.5–101.6 78.7–86.4
      L 106.7–114.3 88.9–96.5
      XL 116.8–121.9 101.6–106.7
      XXL 124.5–132.1 109.2–114.3
    `),
  ]],
  ['thenorthface', [
    guide('Куртки й верх', 'https://www.thenorthface.com/en-gb/help-section/product-info/size-charts', tops, [size, chest, hips, 'Довжина руки, см'], `
      2XS 76–84 79–84 84
      XS 85–93 85–90 85
      S 94–100 91–98 86
      M 100–108 99–105 86
      L 109–117 106–113 88
      XL 118–126 114–121 89
      2XL 127–137 122–130 90
      3XL 138–148 131–137 91
    `),
  ]],
  ['underarmour', [
    guide('Верх', 'https://www.underarmour.com/en-us/t/size-guide/mens-tops/', tops, [size, 'Груди, ″', 'Талія, ″'], `
      XS 31–34 28–29
      SM 34–37 29–31
      MD 37–41 31–34
      LG 41–44 34–37
      XL 44–48 37–41
      XXL 48–52 41–45½
      3XL 52–56 45½–50
      4XL 56–60 50–54½
      5XL 60–64 54½–59
    `),
    guide('Штани й шорти', 'https://www.underarmour.com/en-us/t/size-guide/mens-bottoms/', bottoms, [size, 'US', 'Талія, ″', 'Стегна, ″'], `
      XS 28 28–29 33–34
      SM 30 29–31 34–36
      MD 32–33 31–34 36–39
      LG 34–36 34–37 39–42
      XL 38–40 37–41 42–46
      XXL 42–44 41–45½ 46–50
      3XL 46–48 45½–50 50–54
      4XL 50–52 50–54½ 54–58
      5XL 54–56 54½–59 58–62
    `),
  ]],
  ['puma', [
    guide('Верх', 'https://eu.puma.com/si/en/help/mobile-app-size-guide', tops, [size, 'DE / FR', 'IT / ES'], `
      XXS 38 38
      XS 40–42 42
      S 44–46 46
      M 48–50 50
      L 52–54 54
      XL 56–58 58
      XXL 60–62 62
      3XL 64–66 66
    `),
  ]],
  ['adidas', [
    guide('Верх', 'https://support.dtb.adidas.com/static-content/size-charts/en_GB/apparel/size-m_tops.html', tops, [size, chest, waist, hips], `
      XS 83–86 71–74 82–85
      S 87–92 75–80 86–91
      M 93–100 81–88 92–99
      L 101–108 89–96 100–107
      XL 109–118 97–106 108–116
      2XL 119–130 107–119 117–125
      3XL 131–142 120–132 126–135
    `),
    guide('Взуття', 'https://www.adidas.co.uk/help/size_charts/men-shoes', shoes, shoeColumns, `
      39⅓ 6 6.5 24.2
      40 6.5 7 24.6
      40⅔ 7 7.5 25
      41⅓ 7.5 8 25.5
      42 8 8.5 25.9
      42⅔ 8.5 9 26.3
      43⅓ 9 9.5 26.7
      44 9.5 10 27.1
      44⅔ 10 10.5 27.6
      45⅓ 10.5 11 28
      46 11 11.5 28.4
    `),
  ]],
  ['nike', [
    guide('Взуття', 'https://www.nike.com/hr/size-fit/mens-footwear', shoes, ['EU', 'UK', 'US', 'CM/JP на етикетці'], `
      39 6 6.5 24.5
      40 6 7 25
      40.5 6.5 7.5 25.5
      41 7 8 26
      42 7.5 8.5 26.5
      42.5 8 9 27
      43 8.5 9.5 27.5
      44 9 10 28
      44.5 9.5 10.5 28.5
      45 10 11 29
      45.5 10.5 11.5 29.5
      46 11 12 30
    `),
    guide('Штани й шорти', 'https://www.nike.com/hr/size-fit/mens-bottoms-alpha', bottoms, [size, 'Талія, ″', 'Стегна, ″'], `
      XXS 22.5–25.5 28.5–31.5
      XS 25.5–29 31.5–35
      S 29–32 35–37.5
      M 32–35 37.5–41
      L 35–38 41–44
      XL 38–43 44–47
      XXL 43–47.5 47–50.5
      3XL 47.5–52.5 50.5–53.5
      4XL 52.5–57 53.5–58.5
    `),
  ]],
  ['timberland', [
    guide('Взуття', 'https://www.timberland.com/es-es/atencion-al-cliente/tabla-de-tallas', shoes, ['EU', 'UK', 'US', 'CM'], `
      39 5.5 6 24.2
      39.5 6 6.5 24.5
      40 6.5 7 25
      41 7 7.5 25.5
      41.5 7.5 8 26
      42 8 8.5 26.5
      43 8.5 9 27
      43.5 9 9.5 27.5
      44 9.5 10 28
      44.5 10 10.5 28.5
      45 10.5 11 29
      45.5 11 11.5 29.5
      46 11.5 12 30
    `),
  ]],
  ['vans', [
    guide('Взуття', 'https://www.vans.com/en-ie/help/size-charts', shoes, shoeColumns, `
      40.5 7 8 26
      41 7.5 8.5 26.5
      42 8 9 27
      42.5 8.5 9.5 27.5
      43 9 10 28
      44 9.5 10.5 28.5
      44.5 10 11 29
      45 10.5 11.5 29.5
      46 11 12 30
      47 12 13 31
      48 13 14 32
    `),
  ]],
  ['castelli', [
    guide('Велофутболки', 'https://www.castelli-cycling.com/en-eu/pages/customer-service-size-and-fit-guide', ['tees'], [size, chest, waist], `
      XS 88 76
      S 92 80
      M 96 84
      L 100 88
      XL 105 93
      2XL 110 98
      3XL 115 103
    `),
  ]],
  ['speedo', [
    guide('Плавки й джамери', 'https://speedo.com/en-eu/products/mens-endurance-aquashort-black-8134480001', ['shorts'], [size, 'EU', waist, hips], `
      26 XXS 63–67 76–81
      28 XXS 68–72 82–86
      30 XS 73–77 87–91
      32 S 78–82 92–96
      34 M 83–87 97–101
      36 L 88–92 102–106
      38 L 93–97 107–111
      40 XL 98–102 112–116
      42 XL 103–107 117–121
      44 XXL 108–112 122–126
      46 XXL 113–117 127–131
    `),
  ]],
  ['abus', [{
    title: 'Велошоломи',
    url: 'https://www.abus.com/int/Guide/Bicycle-safety/Adjusting-your-bicycle-helmet-correctly',
    categories: ['accessories'],
    columns: [],
    rows: [],
  }]],
]);

export const sizeGuides = (brand: string): readonly Guide[] => guides.get(brandKey(brand)) ?? [];

const SIZE_ALIAS: Record<string, string> = { SM: 'S', MD: 'M', LG: 'L', '2XS': 'XXS', '2XL': 'XXL' };
const sizeKey = (value: string) => {
  const key = value.toUpperCase().replace('½', '.5');
  return SIZE_ALIAS[key] ?? key;
};

/** The chart rows that are my size: «W33 L32» is row 33 of a W column and row 32 of an L column; «DE 6 / UK 36» matches row 36. */
export function myRows(guide: Guide, sizes: readonly string[]): Set<string> {
  const column = guide.columns[0];
  const wanted = new Set<string>();
  for (const size of sizes) {
    for (const token of size.toUpperCase().replace(/(\d),(\d)/g, '$1.$2').split(/[\s/,;·]+/).filter(Boolean)) {
      const fit = token.match(/^([WL])(\d+(?:\.\d+)?)$/);
      if (!fit) wanted.add(sizeKey(token));
      else if (fit[1] === column) wanted.add(fit[2]);
    }
  }
  return new Set(guide.rows.map(([first]) => first).filter((first) => wanted.has(sizeKey(first))));
}
