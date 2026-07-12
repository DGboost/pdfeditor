import type { DocPage } from '../types/pdfEditor';

export function makeInitialPages(): DocPage[] {
  return [
    {
      id: 'p1', label: '1페이지', kind: 'doc', images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0,
      blocks: [
        { id: 'p1-t', type: 'title', text: '용역 계약서' },
        { id: 'p1-i', type: 'text', text: '본 계약은 주식회사 OO(이하 "갑")와 OOO(이하 "을") 간의 용역 제공에 관한 사항을 정함을 목적으로 한다.' },
        { id: 'p1-c1', type: 'clause', label: '제1조 (목적)', text: '본 계약은 갑이 을에게 위탁하는 웹 서비스 개발 용역의 범위와 조건을 정함을 목적으로 한다.' },
        { id: 'p1-c2', type: 'clause', label: '제2조 (계약기간)', text: '본 계약의 유효기간은 2026년 7월 9일부터 2026년 12월 31일까지로 한다.' },
        { id: 'p1-c3', type: 'clause', label: '제3조 (용역대금)', text: '을은 본 용역의 대가로 총 금 30,000,000원(부가세 별도)을 갑으로부터 지급받는다. 대금은 계약 체결 시 50%, 최종 납품 시 50%로 분할 지급한다.' },
        { id: 'p1-c4', type: 'clause', label: '제4조 (업무범위)', text: '을이 수행하는 업무의 범위는 별첨 명세서에 따른다.' },
      ],
    },
    {
      id: 'p2', label: '2페이지', kind: 'doc', images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0,
      blocks: [
        { id: 'p2-c1', type: 'clause', label: '제5조 (권리와 의무)', text: '갑과 을은 신의성실의 원칙에 따라 본 계약을 이행하여야 하며, 상호 협의 없이 계약 내용을 임의로 변경할 수 없다.' },
        { id: 'p2-c2', type: 'clause', label: '제6조 (비밀유지)', text: '을은 본 계약 수행 과정에서 취득한 갑의 영업비밀 및 기술정보를 계약 종료 후에도 제3자에게 누설하여서는 아니 된다.' },
        { id: 'p2-c3', type: 'clause', label: '제7조 (손해배상)', text: '갑 또는 을이 본 계약을 위반하여 상대방에게 손해를 끼친 경우, 그 손해를 배상하여야 한다.' },
        { id: 'p2-c4', type: 'clause', label: '제8조 (계약해지)', text: '갑 또는 을은 상대방이 본 계약을 위반하고 그 시정을 요구받은 후 7일 이내에 시정하지 아니한 경우 서면 통지로 계약을 해지할 수 있다.' },
        { id: 'p2-c5', type: 'clause', label: '제9조 (지식재산권)', text: '본 용역의 결과물에 대한 지식재산권은 대금 완납을 조건으로 갑에게 귀속된다.' },
      ],
    },
    {
      id: 'p3', label: '3페이지', kind: 'doc', images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0,
      blocks: [
        { id: 'p3-c1', type: 'clause', label: '제10조 (기타)', text: '본 계약에 명시되지 않은 사항은 관계 법령 및 상관례에 따른다.' },
        { id: 'p3-a', type: 'text', text: '부칙: 본 계약의 성립을 증명하기 위하여 계약서 2부를 작성하여 갑과 을이 각각 서명 날인 후 1부씩 보관한다.' },
        { id: 'p3-d', type: 'text', text: '2026년 7월 9일' },
        { id: 'p3-party-gap', type: 'party', role: '"갑" (발주자)', name: '회사명: 주식회사 OO   대표자: OOO', which: 'gap' },
        { id: 'p3-party-eul', type: 'party', role: '"을" (수급인)', name: '성명: OOO', which: 'eul' },
      ],
    },
  ];
}
