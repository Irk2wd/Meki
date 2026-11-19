import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

export async function writeReportPdf(file) {
  const colors = ['0.28 0.49 0.65', '0.27 0.58 0.42', '0.52 0.31 0.57'];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 3 /Kids [3 0 R 5 0 R 7 0 R] >>',
  ];
  for (const [index, color] of colors.entries()) {
    const stream = `${color} rg 0 0 480 270 re f\n1 1 1 rg BT /F1 24 Tf 36 144 Td (Research report page ${index + 1}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 270] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 9 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fs.writeFile(file, pdf);
}

export async function writeReportPptx(file) {
  const zip = new ZipFile();
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const namespaces = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
  const add = (name, xml) => zip.addBuffer(Buffer.from(xml), name);
  // File numbers deliberately differ from the presentation order.
  const slides = [{ file: 3, name: 'First' }, { file: 1, name: 'Second' }, { file: 2, name: 'Third' }];
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    ${slides.map(slide => `<Override PartName="/ppt/slides/slide${slide.file}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}
  </Types>`);
  add('_rels/.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  add('ppt/presentation.xml', `<p:presentation ${namespaces}><p:sldIdLst>
    ${slides.map((slide, i) => `<p:sldId id="${256 + i}" r:id="rId${slide.file}"/>`).join('')}
    </p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  add('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${relationships}">
    ${slides.map(slide => `<Relationship Id="rId${slide.file}" Type="${office}/slide" Target="slides/slide${slide.file}.xml"/>`).join('')}
  </Relationships>`);
  add('ppt/slides/_rels/slide3.xml.rels', `<Relationships xmlns="${relationships}">
    <Relationship Id="rIdImage" Type="${office}/image" TargetMode="External" Target="https://report-preview.invalid/linked.png"/>
  </Relationships>`);
  for (const slide of slides) add(`ppt/slides/slide${slide.file}.xml`, `<p:sld ${namespaces}><p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Report heading"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="510000" y="700000"/><a:ext cx="8000000" cy="1500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"><a:solidFill><a:srgbClr val="223344"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${slide.name} report slide</a:t></a:r></a:p></p:txBody>
    </p:sp>
    ${slide.file === 3 ? `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Linked image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:link="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="510000" y="2600000"/><a:ext cx="1200000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` : ''}
  </p:spTree></p:cSld></p:sld>`);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}
