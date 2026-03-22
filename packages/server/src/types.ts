export interface SymbolDef {
    name: string;
    type: 'label' | 'constant' | 'macro' | 'section';
    file: string;
    line: number;
    col: number;
    endCol: number;
    isLocal: boolean;
    isExported: boolean;
    parentLabel?: string;
}

export interface SymbolRef {
    name: string;
    file: string;
    line: number;
    col: number;
    endCol: number;
}
