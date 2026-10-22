import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, PermissionsAndroid, Platform, Alert } from 'react-native';
import RNBluetoothClassic, { BluetoothDevice } from 'react-native-bluetooth-classic';
import { LineChart } from 'react-native-chart-kit';
import AsyncStorage from '@react-native-async-storage/async-storage';

const screenWidth = Dimensions.get('window').width;

interface SavedRecord {
  id: string;
  timestamp: string;
  hrData: number[];
  spo2Data: number[];
}

export default function Home() {
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [connected, setConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // Estados actuales
  const [currentHR, setCurrentHR] = useState<number>(0);
  const [currentSpO2, setCurrentSpO2] = useState<number>(0);

  // Historiales en vivo
  const [hrHistory, setHrHistory] = useState<number[]>(new Array(20).fill(0));
  const [spo2History, setSpo2History] = useState<number[]>(new Array(20).fill(0));
  
  // Historial de la onda Pletismográfica (50 muestras para mayor fluidez)
  const [irHistory, setIrHistory] = useState<number[]>(new Array(50).fill(0));

  const [savedRecords, setSavedRecords] = useState<SavedRecord[]>([]);

  useEffect(() => {
    RNBluetoothClassic.requestBluetoothEnabled().catch(() => {
      console.log('El usuario no habilitó el Bluetooth');
    });

    loadSavedRecords();

    return () => {
      if (device) {
        device.disconnect();
      }
    };
  }, []);

  const loadSavedRecords = async () => {
    try {
      const jsonValue = await AsyncStorage.getItem('@historial_medico');
      if (jsonValue != null) {
        setSavedRecords(JSON.parse(jsonValue));
      }
    } catch (e) {
      console.error('Error cargando el historial', e);
    }
  };

  const saveCurrentRecord = async () => {
    if (hrHistory.every(val => val === 0)) {
      Alert.alert('Aviso', 'No hay datos reales para guardar todavía.');
      return;
    }

    const newRecord: SavedRecord = {
      id: Date.now().toString(),
      timestamp: new Date().toLocaleString(),
      hrData: [...hrHistory],
      spo2Data: [...spo2History]
    };

    const updatedRecords = [newRecord, ...savedRecords];

    try {
      await AsyncStorage.setItem('@historial_medico', JSON.stringify(updatedRecords));
      setSavedRecords(updatedRecords);
      Alert.alert('Éxito', 'El registro se guardó correctamente.');
    } catch (e) {
      console.error('Error guardando el registro', e);
      Alert.alert('Error', 'No se pudo guardar el registro.');
    }
  };

  const clearRecords = async () => {
    try {
      await AsyncStorage.removeItem('@historial_medico');
      setSavedRecords([]);
      Alert.alert('Borrado', 'El historial guardado ha sido eliminado.');
    } catch (e) {
      console.error('Error borrando el historial', e);
    }
  };

  const requestBluetoothPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        if (Platform.Version >= 31) {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);
        } else {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          );
        }
      } catch (err) {
        console.warn('Error al solicitar permisos:', err);
      }
    }
  };

  const connectToDevice = async () => {
    setIsScanning(true);
    try {
      await requestBluetoothPermissions();
      const paired = await RNBluetoothClassic.getBondedDevices();
      let targetDevice = paired.find((d) => d.name === 'ESP32-MAX30102');

      if (!targetDevice) {
        const unpaired = await RNBluetoothClassic.startDiscovery();
        targetDevice = unpaired.find((d) => d.name === 'ESP32-MAX30102');
      }

      if (targetDevice) {
        setDevice(targetDevice);
        const isConnected = await targetDevice.connect();
        setConnected(isConnected);

        if (isConnected) {
          targetDevice.onDataReceived((data) => processData(data.data));
        } else {
          Alert.alert('Error', 'Se encontró el ESP32, pero falló la conexión.');
        }
      } else {
        Alert.alert('Error', 'No se encontró el ESP32-MAX30102.');
      }
    } catch (err: any) {
      console.error(err);
      Alert.alert('Error en Bluetooth', err.message);
    }
    setIsScanning(false);
  };

  const processData = (rawData: string) => {
    // 1. Extraer HR y SpO2
    const hrMatch = rawData.match(/HR:(\d+)/);
    const spo2Match = rawData.match(/SpO2:(\d+)/);

    if (hrMatch && spo2Match) {
      const hr = parseInt(hrMatch[1], 10);
      const spo2 = parseInt(spo2Match[1], 10);

      setCurrentHR(hr);
      setCurrentSpO2(spo2);

      setHrHistory((prev) => {
        const newArr = [...prev, hr];
        return newArr.slice(-20);
      });

      setSpo2History((prev) => {
        const newArr = [...prev, spo2];
        return newArr.slice(-20);
      });
    }

    // 2. Extraer todos los valores IR para la onda pletismográfica
    const irMatches = [...rawData.matchAll(/IR=(\d+)/g)];
    if (irMatches.length > 0) {
      const newIrs = irMatches.map(m => parseInt(m[1], 10));
      setIrHistory((prev) => {
        // Evitamos valores nulos o que aplanen la gráfica si no hay dedo (ej. valores menores a 50000)
        const validIrs = newIrs.filter(val => val > 10000); 
        if (validIrs.length === 0) return prev;
        
        const newArr = [...prev, ...validIrs];
        return newArr.slice(-50); // Mantenemos 50 puntos para ver la onda
      });
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.title}>Monitor de Signos Vitales</Text>
        <Text style={styles.subtitle}>MAX30102 + ESP32</Text>
      </View>

      <TouchableOpacity 
        style={[styles.connectButton, connected && styles.connectedButton]} 
        onPress={connectToDevice}
        disabled={isScanning || connected}
      >
        {isScanning ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <Text style={styles.buttonText}>
            {connected ? 'Conectado al Oximetro' : 'Conectar por Bluetooth'}
          </Text>
        )}
      </TouchableOpacity>

      <View style={styles.cardsContainer}>
        <View style={[styles.card, { borderTopColor: '#FF4B4B', borderTopWidth: 4 }]}>
          <Text style={styles.cardLabel}>Ritmo Cardíaco</Text>
          <Text style={styles.cardValue}>{currentHR} <Text style={styles.unit}>BPM</Text></Text>
        </View>
        <View style={[styles.card, { borderTopColor: '#00D1FF', borderTopWidth: 4 }]}>
          <Text style={styles.cardLabel}>Oxigenación</Text>
          <Text style={styles.cardValue}>{currentSpO2} <Text style={styles.unit}>%</Text></Text>
        </View>
      </View>

      {/* Nueva Onda Pletismográfica */}
      <View style={styles.chartContainer}>
        <Text style={styles.chartTitle}>Onda Pletismográfica (IR)</Text>
        <LineChart
          data={{ labels: [], datasets: [{ data: irHistory.every(v => v === 0) ? [0, 1] : irHistory }] }}
          width={screenWidth - 40}
          height={150}
          withDots={false}
          withHorizontalLabels={false} // Ocultamos los números grandes de IR
          withVerticalLines={false}
          withHorizontalLines={false}
          chartConfig={{
            backgroundColor: '#1E1E2D', backgroundGradientFrom: '#1E1E2D', backgroundGradientTo: '#1E1E2D',
            color: (opacity = 1) => `rgba(0, 255, 100, ${opacity})`, // Verde estilo monitor médico
            style: { borderRadius: 16 },
          }}
          bezier
          style={styles.chart}
        />
      </View>

      <View style={styles.chartContainer}>
        <Text style={styles.chartTitle}>Historial HR en vivo</Text>
        <LineChart
          data={{ labels: [], datasets: [{ data: hrHistory }] }}
          width={screenWidth - 40}
          height={200}
          withDots={true}
          yAxisSuffix=" bpm"
          chartConfig={{
            backgroundColor: '#1E1E2D', backgroundGradientFrom: '#1E1E2D', backgroundGradientTo: '#1E1E2D',
            decimalPlaces: 0, color: (opacity = 1) => `rgba(255, 75, 75, ${opacity})`, labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
            style: { borderRadius: 16 },
          }}
          bezier
          style={styles.chart}
        />
      </View>

      <View style={styles.chartContainer}>
        <Text style={styles.chartTitle}>Historial SpO2 en vivo</Text>
        <LineChart
          data={{ labels: [], datasets: [{ data: spo2History }] }}
          width={screenWidth - 40}
          height={200}
          withDots={true}
          yAxisSuffix=" %"
          chartConfig={{
            backgroundColor: '#1E1E2D', backgroundGradientFrom: '#1E1E2D', backgroundGradientTo: '#1E1E2D',
            decimalPlaces: 0, color: (opacity = 1) => `rgba(0, 209, 255, ${opacity})`, labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
            style: { borderRadius: 16 },
          }}
          bezier
          style={styles.chart}
        />
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={saveCurrentRecord}>
        <Text style={styles.buttonText}>Guardar Registro Actual</Text>
      </TouchableOpacity>

      <View style={styles.recordsSection}>
        <View style={styles.recordsHeader}>
          <Text style={styles.recordsTitle}>Registros Guardados</Text>
          {savedRecords.length > 0 && (
            <TouchableOpacity onPress={clearRecords}>
              <Text style={styles.clearText}>Borrar Todos</Text>
            </TouchableOpacity>
          )}
        </View>
        
        {savedRecords.length === 0 ? (
          <Text style={styles.noRecordsText}>No hay registros guardados.</Text>
        ) : (
          savedRecords.map((record) => {
            const avgHR = Math.round(record.hrData.reduce((a, b) => a + b, 0) / record.hrData.length);
            const avgSpO2 = Math.round(record.spo2Data.reduce((a, b) => a + b, 0) / record.spo2Data.length);
            
            return (
              <View key={record.id} style={styles.recordCard}>
                <Text style={styles.recordDate}>{record.timestamp}</Text>
                <View style={styles.recordAverages}>
                  <Text style={styles.recordMetric}>Promedio HR: <Text style={{color: '#FF4B4B'}}>{avgHR} bpm</Text></Text>
                  <Text style={styles.recordMetric}>Promedio SpO2: <Text style={{color: '#00D1FF'}}>{avgSpO2} %</Text></Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A', padding: 20 },
  header: { marginTop: 40, marginBottom: 20, alignItems: 'center' },
  title: { fontSize: 26, color: '#FFF', fontWeight: 'bold' },
  subtitle: { fontSize: 14, color: '#A0A0B0', marginTop: 4 },
  connectButton: { backgroundColor: '#6C63FF', padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 24, elevation: 5 },
  connectedButton: { backgroundColor: '#00C896' },
  saveButton: { backgroundColor: '#FF8C00', padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 30, elevation: 5 },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  cardsContainer: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  card: { backgroundColor: '#1E1E2D', width: '48%', padding: 20, borderRadius: 16, alignItems: 'center', elevation: 4 },
  cardLabel: { color: '#A0A0B0', fontSize: 14, fontWeight: '500', marginBottom: 8 },
  cardValue: { color: '#FFF', fontSize: 36, fontWeight: 'bold' },
  unit: { fontSize: 16, color: '#8A8A9D' },
  chartContainer: { backgroundColor: '#1E1E2D', borderRadius: 16, padding: 16, marginBottom: 20 },
  chartTitle: { color: '#FFF', fontSize: 16, fontWeight: '600', marginBottom: 12 },
  chart: { borderRadius: 16 },
  recordsSection: { marginTop: 10 },
  recordsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  recordsTitle: { color: '#FFF', fontSize: 20, fontWeight: 'bold' },
  clearText: { color: '#FF4B4B', fontSize: 14, fontWeight: '600' },
  noRecordsText: { color: '#A0A0B0', fontSize: 14, fontStyle: 'italic', textAlign: 'center', marginTop: 10 },
  recordCard: { backgroundColor: '#1E1E2D', padding: 16, borderRadius: 12, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#6C63FF' },
  recordDate: { color: '#FFF', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  recordAverages: { flexDirection: 'row', justifyContent: 'space-between' },
  recordMetric: { color: '#A0A0B0', fontSize: 14, fontWeight: '500' }
});