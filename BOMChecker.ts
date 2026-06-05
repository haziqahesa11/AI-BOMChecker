// types.ts
export interface CRDSpec {
  // Common fields - adjust based on your actual schema
  SKU: string;
  ProductCode?: string;
  ComponentID?: string;
  Quantity?: number;
  Revision?: string;
  EffectiveDate?: Date;
  ExpiryDate?: Date;
  Status?: string;
  UnitOfMeasure?: string;
  Manufacturer?: string;
  [key: string]: any; // For additional dynamic fields
}

export interface SysBom {
  // Common fields - adjust based on your actual schema
  SKU?: string;
  ParentPart?: string;
  ComponentPart?: string;
  QuantityPerParent?: number;
  RevisionLevel?: string;
  EffectivityDate?: Date;
  ObsoleteDate?: Date;
  BomStatus?: string;
  ScrapPercentage?: number;
  [key: string]: any;
}

export interface ComparisonResult {
  id: string;
  sku: string;
  componentId: string;
  status: 'MATCH' | 'MISMATCH' | 'MISSING_IN_CRD' | 'MISSING_IN_BOM' | 'QUALITY_ISSUE';
  discrepancies: Discrepancy[];
  qualityScore: number;
  details: {
    crdRecord?: Partial<CRDSpec>;
    bomRecord?: Partial<SysBom>;
  };
}

export interface Discrepancy {
  field: string;
  expectedValue: any;
  actualValue: any;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

export interface ComparisonConfig {
  matchKeys: {
    crdField: keyof CRDSpec;
    bomField: keyof SysBom;
    fuzzyMatch?: boolean;
    caseSensitive?: boolean;
  }[];
  compareFields: {
    crdField: keyof CRDSpec;
    bomField: keyof SysBom;
    tolerance?: number; // For numeric comparisons
    ignoreCase?: boolean;
    required?: boolean;
    weight: number; // For quality scoring
  }[];
  qualityThresholds: {
    critical: number;
    warning: number;
    acceptable: number;
  };
}

// database-connector.ts
export interface DatabaseConnector {
  executeQuery<T>(query: string): Promise<T[]>;
}

export class SQLServerConnector implements DatabaseConnector {
  constructor(private connectionString: string) {}

  async executeQuery<T>(query: string): Promise<T[]> {
    // Implementation for actual SQL Server connection
    // Using mssql or tedious library
    console.log(`Executing query on ${this.connectionString}`);
    // Return mock data for example
    return [];
  }
}

// data-quality-checker.ts
export class DataQualityChecker {
  validateCRDRecord(record: CRDSpec): QualityIssue[] {
    const issues: QualityIssue[] = [];
    
    if (!record.SKU || record.SKU.trim() === '') {
      issues.push({
        field: 'SKU',
        issue: 'Missing or empty SKU',
        severity: 'CRITICAL'
      });
    }
    
    if (record.Quantity !== undefined && record.Quantity <= 0) {
      issues.push({
        field: 'Quantity',
        issue: 'Invalid quantity (must be > 0)',
        severity: 'HIGH',
        actualValue: record.Quantity
      });
    }
    
    if (record.EffectiveDate && record.ExpiryDate && record.EffectiveDate > record.ExpiryDate) {
      issues.push({
        field: 'DateRange',
        issue: 'Effective date after expiry date',
        severity: 'CRITICAL'
      });
    }
    
    return issues;
  }
  
  validateBOMRecord(record: SysBom): QualityIssue[] {
    const issues: QualityIssue[] = [];
    
    if (!record.ComponentPart || record.ComponentPart.trim() === '') {
      issues.push({
        field: 'ComponentPart',
        issue: 'Missing component part number',
        severity: 'CRITICAL'
      });
    }
    
    if (record.QuantityPerParent !== undefined && record.QuantityPerParent <= 0) {
      issues.push({
        field: 'QuantityPerParent',
        issue: 'Invalid quantity (must be > 0)',
        severity: 'HIGH',
        actualValue: record.QuantityPerParent
      });
    }
    
    return issues;
  }
}

// bom-crd-comparator.ts
export class BOMCRDComparator {
  private qualityChecker: DataQualityChecker;
  
  constructor(
    private crdConnector: DatabaseConnector,
    private bomConnector: DatabaseConnector,
    private config: ComparisonConfig
  ) {
    this.qualityChecker = new DataQualityChecker();
  }
  
  async fetchData(): Promise<{ crdData: CRDSpec[]; bomData: SysBom[] }> {
    const crdQuery = `SELECT c.* FROM MSFT_SKU.dbo.CRDspec AS c`;
    const bomQuery = `SELECT sb.* FROM BOM.dbo.SysBom AS sb`;
    
    const [crdData, bomData] = await Promise.all([
      this.crdConnector.executeQuery<CRDSpec>(crdQuery),
      this.bomConnector.executeQuery<SysBom>(bomQuery)
    ]);
    
    return { crdData, bomData };
  }
  
  async compare(): Promise<ComparisonResult[]> {
    const { crdData, bomData } = await this.fetchData();
    
    // Create indexes for efficient lookup
    const bomIndex = this.createBOMIndex(bomData);
    const results: ComparisonResult[] = [];
    
    // Check each CRD record against BOM
    for (const crdRecord of crdData) {
      const matchedBomRecords = this.findMatchingBOMRecords(crdRecord, bomIndex);
      
      if (matchedBomRecords.length === 0) {
        results.push(this.createMissingInBOMResult(crdRecord));
      } else {
        for (const bomRecord of matchedBomRecords) {
          results.push(await this.compareRecords(crdRecord, bomRecord));
        }
      }
    }
    
    // Find BOM records not in CRD
    const matchedCRDKeys = new Set(results.map(r => `${r.sku}|${r.componentId}`));
    for (const bomRecord of bomData) {
      const key = this.getMatchKey(bomRecord);
      if (!matchedCRDKeys.has(key)) {
        results.push(this.createMissingInCRDResult(bomRecord));
      }
    }
    
    return results;
  }
  
  private createBOMIndex(bomData: SysBom[]): Map<string, SysBom[]> {
    const index = new Map<string, SysBom[]>();
    
    for (const bomRecord of bomData) {
      const key = this.getMatchKey(bomRecord);
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)!.push(bomRecord);
    }
    
    return index;
  }
  
  private getMatchKey(record: SysBom | CRDSpec): string {
    // Implement based on your match keys configuration
    const matchParts = this.config.matchKeys.map(mk => {
      let value = record[mk.bomField as keyof typeof record];
      if (typeof value === 'string' && !this.config.matchKeys[0].caseSensitive) {
        value = value.toLowerCase();
      }
      return value;
    });
    
    return matchParts.join('|');
  }
  
  private findMatchingBOMRecords(crdRecord: CRDSpec, bomIndex: Map<string, SysBom[]>): SysBom[] {
    const key = this.getMatchKey(crdRecord);
    return bomIndex.get(key) || [];
  }
  
  private async compareRecords(crdRecord: CRDSpec, bomRecord: SysBom): Promise<ComparisonResult> {
    const discrepancies: Discrepancy[] = [];
    let qualityScore = 100;
    
    // Check CRD quality
    const crdQualityIssues = this.qualityChecker.validateCRDRecord(crdRecord);
    qualityScore -= crdQualityIssues.length * 10;
    
    // Check BOM quality
    const bomQualityIssues = this.qualityChecker.validateBOMRecord(bomRecord);
    qualityScore -= bomQualityIssues.length * 10;
    
    // Compare configured fields
    for (const fieldConfig of this.config.compareFields) {
      const crdValue = crdRecord[fieldConfig.crdField];
      const bomValue = bomRecord[fieldConfig.bomField];
      
      const isEqual = this.compareValues(
        crdValue, 
        bomValue, 
        fieldConfig.tolerance, 
        fieldConfig.ignoreCase
      );
      
      if (!isEqual) {
        const severity = this.getSeverity(fieldConfig.weight);
        discrepancies.push({
          field: fieldConfig.crdField as string,
          expectedValue: crdValue,
          actualValue: bomValue,
          severity,
          message: `Mismatch in ${fieldConfig.crdField}: expected ${crdValue}, found ${bomValue}`
        });
        
        // Reduce quality score based on field weight
        qualityScore -= (fieldConfig.weight / 10);
      }
    }
    
    const status = this.determineStatus(discrepancies, qualityScore);
    
    return {
      id: `${crdRecord.SKU}|${crdRecord.ComponentID || bomRecord.ComponentPart}`,
      sku: crdRecord.SKU || bomRecord.SKU || 'UNKNOWN',
      componentId: crdRecord.ComponentID || bomRecord.ComponentPart || 'UNKNOWN',
      status,
      discrepancies,
      qualityScore: Math.max(0, qualityScore),
      details: {
        crdRecord: this.sanitizeRecord(crdRecord),
        bomRecord: this.sanitizeRecord(bomRecord)
      }
    };
  }
  
  private compareValues(
    val1: any, 
    val2: any, 
    tolerance?: number, 
    ignoreCase?: boolean
  ): boolean {
    if (val1 === val2) return true;
    if (val1 == null && val2 == null) return true;
    if (val1 == null || val2 == null) return false;
    
    if (typeof val1 === 'number' && typeof val2 === 'number' && tolerance) {
      return Math.abs(val1 - val2) <= tolerance;
    }
    
    if (typeof val1 === 'string' && typeof val2 === 'string' && ignoreCase) {
      return val1.toLowerCase() === val2.toLowerCase();
    }
    
    if (val1 instanceof Date && val2 instanceof Date) {
      return val1.getTime() === val2.getTime();
    }
    
    return false;
  }
  
  private getSeverity(weight: number): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    if (weight >= 8) return 'CRITICAL';
    if (weight >= 5) return 'HIGH';
    if (weight >= 3) return 'MEDIUM';
    return 'LOW';
  }
  
  private determineStatus(
    discrepancies: Discrepancy[], 
    qualityScore: number
  ): ComparisonResult['status'] {
    if (qualityScore < 60) return 'QUALITY_ISSUE';
    if (discrepancies.some(d => d.severity === 'CRITICAL')) return 'MISMATCH';
    if (discrepancies.length > 0) return 'MISMATCH';
    return 'MATCH';
  }
  
  private createMissingInBOMResult(crdRecord: CRDSpec): ComparisonResult {
    return {
      id: crdRecord.SKU,
      sku: crdRecord.SKU,
      componentId: crdRecord.ComponentID || 'UNKNOWN',
      status: 'MISSING_IN_BOM',
      discrepancies: [{
        field: 'Record',
        expectedValue: 'Present in CRD',
        actualValue: 'Missing in BOM',
        severity: 'CRITICAL',
        message: 'Record found in CRD but not in BOM'
      }],
      qualityScore: 0,
      details: { crdRecord: this.sanitizeRecord(crdRecord) }
    };
  }
  
  private createMissingInCRDResult(bomRecord: SysBom): ComparisonResult {
    return {
      id: bomRecord.ComponentPart || 'UNKNOWN',
      sku: bomRecord.SKU || 'UNKNOWN',
      componentId: bomRecord.ComponentPart || 'UNKNOWN',
      status: 'MISSING_IN_CRD',
      discrepancies: [{
        field: 'Record',
        expectedValue: 'Present in BOM',
        actualValue: 'Missing in CRD',
        severity: 'CRITICAL',
        message: 'Record found in BOM but not in CRD'
      }],
      qualityScore: 0,
      details: { bomRecord: this.sanitizeRecord(bomRecord) }
    };
  }
  
  private sanitizeRecord(record: any): any {
    // Remove sensitive or unnecessary fields
    const sanitized = { ...record };
    delete sanitized.Password;
    delete sanitized.InternalNotes;
    return sanitized;
  }
}

// report-generator.ts
export class ReportGenerator {
  generateSummary(results: ComparisonResult[]): any {
    const summary = {
      totalRecords: results.length,
      matches: results.filter(r => r.status === 'MATCH').length,
      mismatches: results.filter(r => r.status === 'MISMATCH').length,
      missingInBOM: results.filter(r => r.status === 'MISSING_IN_BOM').length,
      missingInCRD: results.filter(r => r.status === 'MISSING_IN_CRD').length,
      qualityIssues: results.filter(r => r.status === 'QUALITY_ISSUE').length,
      averageQualityScore: 0,
      criticalDiscrepancies: 0,
      bySeverity: {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0
      }
    };
    
    let totalQuality = 0;
    for (const result of results) {
      totalQuality += result.qualityScore;
      summary.criticalDiscrepancies += result.discrepancies.filter(d => d.severity === 'CRITICAL').length;
      summary.bySeverity.CRITICAL += result.discrepancies.filter(d => d.severity === 'CRITICAL').length;
      summary.bySeverity.HIGH += result.discrepancies.filter(d => d.severity === 'HIGH').length;
      summary.bySeverity.MEDIUM += result.discrepancies.filter(d => d.severity === 'MEDIUM').length;
      summary.bySeverity.LOW += result.discrepancies.filter(d => d.severity === 'LOW').length;
    }
    
    summary.averageQualityScore = results.length > 0 ? totalQuality / results.length : 0;
    
    return summary;
  }
  
  generateDetailedReport(results: ComparisonResult[]): string {
    const summary = this.generateSummary(results);
    
    let report = '='.repeat(80) + '\n';
    report += 'BOM vs CRD SPECIFICATION COMPARISON REPORT\n';
    report += '='.repeat(80) + '\n\n';
    
    report += `Generated: ${new Date().toISOString()}\n\n`;
    
    report += 'SUMMARY STATISTICS\n';
    report += '-'.repeat(40) + '\n';
    report += `Total Records Compared: ${summary.totalRecords}\n`;
    report += `✅ Matches: ${summary.matches}\n`;
    report += `⚠️  Mismatches: ${summary.mismatches}\n`;
    report += `❌ Missing in BOM: ${summary.missingInBOM}\n`;
    report += `❌ Missing in CRD: ${summary.missingInCRD}\n`;
    report += `🔧 Quality Issues: ${summary.qualityIssues}\n`;
    report += `📊 Average Quality Score: ${summary.averageQualityScore.toFixed(2)}/100\n`;
    report += `🔥 Critical Discrepancies: ${summary.criticalDiscrepancies}\n\n`;
    
    report += 'DISCREPANCIES BY SEVERITY\n';
    report += '-'.repeat(40) + '\n';
    report += `CRITICAL: ${summary.bySeverity.CRITICAL}\n`;
    report += `HIGH: ${summary.bySeverity.HIGH}\n`;
    report += `MEDIUM: ${summary.bySeverity.MEDIUM}\n`;
    report += `LOW: ${summary.bySeverity.LOW}\n\n`;
    
    // Detailed mismatches
    const mismatches = results.filter(r => r.status !== 'MATCH');
    if (mismatches.length > 0) {
      report += 'DETAILED DISCREPANCIES\n';
      report += '-'.repeat(40) + '\n';
      
      for (const mismatch of mismatches.slice(0, 100)) { // Limit to 100 for readability
        report += `\nSKU: ${mismatch.sku} | Component: ${mismatch.componentId}\n`;
        report += `Status: ${mismatch.status} | Quality Score: ${mismatch.qualityScore}\n`;
        report += `Discrepancies:\n`;
        for (const disc of mismatch.discrepancies) {
          report += `  - [${disc.severity}] ${disc.message}\n`;
        }
        report += '\n';
      }
    }
    
    return report;
  }
  
  async exportToJSON(results: ComparisonResult[], filePath: string): Promise<void> {
    const fs = await import('fs/promises');
    const data = {
      generatedAt: new Date().toISOString(),
      summary: this.generateSummary(results),
      details: results
    };
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }
  
  async exportToCSV(results: ComparisonResult[], filePath: string): Promise<void> {
    const fs = await import('fs/promises');
    const rows = [['SKU', 'Component ID', 'Status', 'Quality Score', 'Discrepancies']];
    
    for (const result of results) {
      rows.push([
        result.sku,
        result.componentId,
        result.status,
        result.qualityScore.toString(),
        result.discrepancies.map(d => `${d.field}: ${d.message}`).join('; ')
      ]);
    }
    
    const csvContent = rows.map(row => row.join(',')).join('\n');
    await fs.writeFile(filePath, csvContent);
  }
}

// main.ts - Usage example
async function main() {
  // Configuration for your specific comparison needs
  const config: ComparisonConfig = {
    matchKeys: [
      { crdField: 'SKU', bomField: 'ParentPart', caseSensitive: false },
      { crdField: 'ComponentID', bomField: 'ComponentPart', caseSensitive: false }
    ],
    compareFields: [
      { crdField: 'Quantity', bomField: 'QuantityPerParent', weight: 10, tolerance: 0.01 },
      { crdField: 'Revision', bomField: 'RevisionLevel', weight: 8, ignoreCase: true },
      { crdField: 'Status', bomField: 'BomStatus', weight: 7, ignoreCase: true },
      { crdField: 'UnitOfMeasure', bomField: 'UnitOfMeasure', weight: 6, ignoreCase: true },
      { crdField: 'Manufacturer', bomField: 'Manufacturer', weight: 5, ignoreCase: true }
    ],
    qualityThresholds: {
      critical: 0,
      warning: 50,
      acceptable: 80
    }
  };
  
  // Initialize connectors with your actual connection strings
  const crdConnector = new SQLServerConnector('Server=MSFT_SQL;Database=MSFT_SKU;Trusted_Connection=true;');
  const bomConnector = new SQLServerConnector('Server=BOM_SQL;Database=BOM;Trusted_Connection=true;');
  
  // Create comparator and run comparison
  const comparator = new BOMCRDComparator(crdConnector, bomConnector, config);
  const results = await comparator.compare();
  
  // Generate reports
  const reporter = new ReportGenerator();
  const summary = reporter.generateSummary(results);
  const report = reporter.generateDetailedReport(results);
  
  console.log(report);
  
  // Export results
  await reporter.exportToJSON(results, './comparison-results.json');
  await reporter.exportToCSV(results, './comparison-results.csv');
  
  // Return non-zero exit code if critical issues found
  if (summary.criticalDiscrepancies > 0 || summary.missingInBOM > 0 || summary.missingInCRD > 0) {
    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main().catch(console.error);
}

export interface QualityIssue {
  field: string;
  issue: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  actualValue?: any;
}