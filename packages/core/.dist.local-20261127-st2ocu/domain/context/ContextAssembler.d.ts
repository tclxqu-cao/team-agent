import type { IContextAssembler, IContextLoader, AssembleInput, AssembledContext } from './entities.js';
export declare class ContextAssembler implements IContextAssembler {
    private readonly contextLoader;
    private readonly operatingSystem;
    constructor(contextLoader: IContextLoader, operatingSystem?: string);
    assemble(input: AssembleInput): Promise<AssembledContext>;
    private buildEnvSection;
    private estimateTokens;
    private estimateHistoryTokens;
    /** Truncate a section to fit within a token budget. */
    private truncateSection;
    /**
     * Truncate the project context section intelligently:
     * keep file headers, truncate individual file contents proportionally.
     */
    private truncateProjectSection;
    /** Fit attributed sections into the final prompt budget without losing ownership. */
    private fitSectionsToBudget;
    private joinSections;
    private truncateText;
}
//# sourceMappingURL=ContextAssembler.d.ts.map