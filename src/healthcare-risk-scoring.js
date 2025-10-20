require('dotenv').config();
const axios = require('axios');

class HealthcareRiskScorer {
    constructor(apiKey, baseURL = 'https://assessment.ksensetech.com/api') {
        this.apiKey = apiKey;
        this.baseURL = baseURL;
        this.allPatients = [];
        
        // Configure axios with retry logic
        this.apiClient = axios.create({
            baseURL: this.baseURL,
            headers: {
                'x-api-key': this.apiKey
            },
            timeout: 10000
        });
    }

    // Retry logic for API calls
    async makeRequestWithRetry(url, maxRetries = 3, retryDelay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await this.apiClient.get(url);
                return response.data;
            } catch (error) {
                if (error.response && [429, 500, 503].includes(error.response.status)) {
                    if (attempt === maxRetries) throw error;
                    console.log(`Attempt ${attempt} failed, retrying in ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                } else {
                    throw error;
                }
            }
        }
    }

    // Fetch all patients with pagination
    async fetchAllPatients() {
        let page = 1;
        let hasNext = true;
        const allPatients = [];

        while (hasNext) {
            try {
                console.log(`Fetching page ${page}...`);
                const data = await this.makeRequestWithRetry(`/patients?page=${page}&limit=20`);
                
                if (data && data.data) {
                    allPatients.push(...data.data);
                    hasNext = data.pagination?.hasNext || false;
                    page++;
                    
                    // Add delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 200));
                } else {
                    break;
                }
            } catch (error) {
                console.error(`Error fetching page ${page}:`, error.message);
                throw error;
            }
        }

        console.log(`Fetched ${allPatients.length} total patients`);
        return allPatients;
    }

    // Parse blood pressure and calculate risk
    calculateBPRisk(bloodPressure) {
        if (!bloodPressure || typeof bloodPressure !== 'string') return 0;

        const parts = bloodPressure.split('/');
        if (parts.length !== 2) return 0;

        const systolic = parseInt(parts[0]);
        const diastolic = parseInt(parts[1]);

        if (isNaN(systolic) || isNaN(diastolic)) return 0;

        // Determine risk category
        if (systolic >= 140 || diastolic >= 90) return 4; // Stage 2
        if (systolic >= 130 || diastolic >= 80) return 3; // Stage 1
        if (systolic >= 120 && diastolic < 80) return 2;  // Elevated
        if (systolic < 120 && diastolic < 80) return 1;   // Normal

        return 0; // Invalid
    }

    // Calculate temperature risk
    calculateTemperatureRisk(temperature) {
        if (temperature === null || temperature === undefined) return 0;

        const temp = parseFloat(temperature);
        if (isNaN(temp)) return 0;

        if (temp >= 101.0) return 2; // High fever
        if (temp >= 99.6) return 1;  // Low fever
        return 0; // Normal
    }

    // Calculate age risk
    calculateAgeRisk(age) {
        if (age === null || age === undefined) return 0;

        const ageNum = parseInt(age);
        if (isNaN(ageNum)) return 0;

        if (ageNum > 65) return 2;
        if (ageNum >= 40) return 1;
        return 1; // Under 40
    }

    // Check if data has quality issues
    hasDataQualityIssues(patient) {
        // Check blood pressure
        if (!patient.blood_pressure || typeof patient.blood_pressure !== 'string') return true;
        
        const bpParts = patient.blood_pressure.split('/');
        if (bpParts.length !== 2) return true;
        if (isNaN(parseInt(bpParts[0])) || isNaN(parseInt(bpParts[1]))) return true;

        // Check temperature
        if (patient.temperature === null || patient.temperature === undefined) return true;
        if (isNaN(parseFloat(patient.temperature))) return true;

        // Check age
        if (patient.age === null || patient.age === undefined) return true;
        if (isNaN(parseInt(patient.age))) return true;

        return false;
    }

    // Process all patients and calculate risks
    processPatients(patients) {
        const results = {
            highRiskPatients: [],
            feverPatients: [],
            dataQualityIssues: []
        };

        patients.forEach(patient => {
            // Check for data quality issues first
            if (this.hasDataQualityIssues(patient)) {
                results.dataQualityIssues.push(patient.patient_id);
                return; // Skip risk calculation for invalid data
            }

            // Calculate individual risk scores
            const bpRisk = this.calculateBPRisk(patient.blood_pressure);
            const tempRisk = this.calculateTemperatureRisk(patient.temperature);
            const ageRisk = this.calculateAgeRisk(patient.age);

            const totalRisk = bpRisk + tempRisk + ageRisk;

            // Categorize patients
            if (totalRisk >= 4) {
                results.highRiskPatients.push(patient.patient_id);
            }

            const temp = parseFloat(patient.temperature);
            if (temp >= 99.6) {
                results.feverPatients.push(patient.patient_id);
            }
        });

        return results;
    }

    // Submit results to API
    async submitResults(results) {
        try {
            const submissionData = {
                high_risk_patients: results.highRiskPatients,
                fever_patients: results.feverPatients,
                data_quality_issues: results.dataQualityIssues
            };

            console.log('Submitting results:', {
                highRisk: results.highRiskPatients.length,
                fever: results.feverPatients.length,
                dataQuality: results.dataQualityIssues.length
            });

            const response = await this.apiClient.post('/submit-assessment', submissionData);
            return response.data;
        } catch (error) {
            console.error('Submission error:', error.response?.data || error.message);
            throw error;
        }
    }

    async runAssessment() {
        try {
            console.log('Starting healthcare risk assessment...');
            console.log('API Key:', this.apiKey ? '✓ Set' : '✗ Missing');
            
            const patients = await this.fetchAllPatients();
            const results = this.processPatients(patients);
            const submissionResult = await this.submitResults(results);
            
            console.log('Assessment completed successfully!');
            return submissionResult;
            
        } catch (error) {
            console.error('Assessment failed:', error.message);
            throw error;
        }
    }
}

module.exports = HealthcareRiskScorer;

if (require.main === module) {
    const apiKey = process.env.API_KEY;
    
    if (!apiKey) {
        console.error('Error: API_KEY environment variable is not set.');
        console.log('Please create a .env file with: API_KEY=your_actual_key_here');
        process.exit(1);
    }
    
    const scorer = new HealthcareRiskScorer(apiKey);
    scorer.runAssessment().catch(console.error);
}
