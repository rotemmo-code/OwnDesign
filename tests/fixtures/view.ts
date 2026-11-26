import { bytes, onePage, ticks } from './hostile';
import { rawPdf } from './makePdf';

/** Page 1 is 600 x 400 with a red square, page 2 is 400 x 600 with a blue one. first: the content of page 1 instead. */
export function twoPages(first = `${ticks(60)}1 0 0 rg 100 100 100 100 re f`): Uint8Array {
  const page = (box: string, content: number) => `<</Type/Page/Parent 2 0 R/MediaBox[${box}]/Contents ${content} 0 R/Resources<<>>>>`;
  return rawPdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Count 2/Kids[3 0 R 4 0 R]>>', page('0 0 600 400', 5), page('0 0 400 600', 6), '<<>>', '<<>>'], {
    5: bytes(first),
    6: bytes(`${ticks(60)}0 0 1 rg 100 100 100 100 re f`),
  });
}

export const COLOURS = ['#9a5c25', '#4a9b55', '#0000ff', '#ff0000', '#808080', '#063906'];
/** A square of 40 pt of each colour, 60 pt apart, the first at 100, 100 from the top left. */
export function coloured(): Uint8Array {
  const part = (hex: string, at: number) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(6);
  return onePage(ticks(60) + COLOURS.map((hex, i) => `${part(hex, 1)} ${part(hex, 3)} ${part(hex, 5)} rg ${80 + 60 * i} 280 40 40 re f`).join('\n'));
}

/** A black 1-bit image of width x height pixels over 300, 100 to 500, 300. */
export const withImage = (width: number, height: number): Uint8Array =>
  onePage(`${ticks(60)}q 200 0 0 200 300 100 cm /I Do Q`, {
    resources: '/XObject<</I 5 0 R>>',
    objects: [`<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}/BitsPerComponent 1/ColorSpace/DeviceGray>>`],
    streams: { 5: new Uint8Array(Math.ceil(width / 8) * height) },
  });

/** For what pdf.js draws wrongly by itself, or only with help: a layer that is off (/Off), a form (/F), a dash of null (/D gs) and of 20 (/E gs), a soft mask that shows the left half (/M gs), an annotation. */
export const special = (content: string, form = ''): Uint8Array =>
  onePage(`${ticks(60)}${content}`, {
    resources: '/Properties<</Off 5 0 R>>/XObject<</F 6 0 R>>/ExtGState<</D<</D null>>/E<</D[[20 20] 0]>>/M<</SMask<</S/Luminosity/G 7 0 R>>>>>>',
    catalog: '/OCProperties<</OCGs[5 0 R]/D<</OFF[5 0 R]>>>>',
    page: '/Annots[8 0 R]',
    objects: [
      '<</Type/OCG/Name(off)>>',
      '<</Type/XObject/Subtype/Form/BBox[0 0 600 400]>>',
      '<</Type/XObject/Subtype/Form/BBox[0 0 600 400]/Group<</S/Transparency/CS/DeviceGray>>>>',
      '<</Type/Annot/Subtype/Square/Rect[500 300 560 360]/F 4/AP<</N 9 0 R>>>>',
      '<</Type/XObject/Subtype/Form/BBox[0 0 60 60]>>',
    ],
    streams: { 6: bytes(form), 7: bytes('1 g 0 0 150 400 re f'), 9: bytes('1 0 0 rg 0 0 60 60 re f') },
  });
