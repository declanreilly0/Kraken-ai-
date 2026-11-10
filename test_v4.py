import math
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
import kraken
from analysis_engine import ema, rsi, atr, scenario, analyze
from main import app

client=TestClient(app)


def sample_pairs():
    return {
        'BEAMGBP':{'wsname':'BEAM/GBP','altname':'BEAMGBP','status':'online','costmin':'1','ordermin':'50'},
        'XXBTZGBP':{'wsname':'XBT/GBP','altname':'XBTGBP','status':'online'},
        'BEAMUSD':{'wsname':'BEAM/USD','status':'online'},
        'PEPEEUR':{'wsname':'PEPE/EUR','status':'online'},
        'XBTUSDT':{'wsname':'XBT/USDT','status':'online'},
        'PAUSEDGBP':{'wsname':'PAUSED/GBP','status':'cancel_only'},
        'DARKGBP.d':{'wsname':'DARK/GBP','status':'online'},
    }


def sample_bars(interval=15):
    n=80
    start=(int(time.time())//(interval*60) - n)*interval*60
    bars=[]
    for i in range(n):
        close=.003+(i*.000001) +(.000005 if i>70 else 0)
        bars.append({'time':start+i*interval*60,'open':close-.0000005,'high':close+.000001,'low':close-.000001,
                     'close':close,'volume':1000*(i+1),'trades':12})
    return bars


def market():
    return {'ask':.0031,'bid':.00309,'spread_pct':.323,'volume_gbp24':200000}


def data():
    return {'pair':{'id':'BEAMGBP','symbol':'BEAM/GBP','base':'BEAM','cost_min':1,'order_min':50},'interval':15,'candles':sample_bars(), 'retrieved_at':time.time()}


def test_gbp_only_and_status(monkeypatch):
    def fake_query(endpoint,params=None,ttl=0):return sample_pairs(),time.time()
    monkeypatch.setattr(kraken,'query',fake_query)
    pairs,ts=kraken.gbp_pairs()
    assert {p['symbol'] for p in pairs}=={'BEAM/GBP','XBT/GBP'}
    assert all(p['quote']=='GBP' for p in pairs)
    assert kraken.require_pair('BEAMGBP')['symbol']=='BEAM/GBP'
    import pytest
    with pytest.raises(kraken.MarketError):kraken.require_pair('BEAMUSD')
    with pytest.raises(kraken.MarketError):kraken.require_pair('BEAM/USD')


def test_tickers_use_direct_gbp_no_usd(monkeypatch):
    def fake_query(endpoint,params=None,ttl=0):
        if endpoint=='AssetPairs':return sample_pairs(),time.time()
        return {'BEAMGBP':{'a':['0.0031'],'b':['0.00308'],'c':['0.00309'],'o':'0.0030','v':['200','1000'],'p':['0.003','0.0031'],'h':['0.004','0.004'],'l':['0.002','0.002']},
                'BEAMUSD':{'a':['3000'],'b':['2900'],'c':['2999'],'o':'1','v':['1','2'],'p':['1','1']}},time.time()
    monkeypatch.setattr(kraken,'query',fake_query)
    out=kraken.tickers()
    assert len(out['markets'])==1
    assert out['markets'][0]['symbol']=='BEAM/GBP'
    assert out['markets'][0]['last']==.00309
    assert out['markets'][0]['spread_pct']>0


def test_uncommitted_candle_excluded():
    d=data(); m=market()
    a=analyze(d,m)
    assert a['bars_used']==len(d['candles'])-1
    assert a['closed_candle_at']==d['candles'][-2]['time']+15*60
    assert sum(x['passed'] for x in a['rules'])==a['score']
    assert a['quote']=='GBP'


def test_stale_candle_is_blocked():
    d=data();
    for b in d['candles']: b['time']-=86400
    a=analyze(d,market())
    assert a['status']=='BLOCKED'
    assert any('stale' in w.lower() for w in a['quality'])


def test_fee_and_stop_math():
    v=scenario(50,.004,.0046,.0038,.4,.1)
    assert v['units']>0
    assert v['target_net_gbp']>0
    assert v['stop_net_gbp']<0
    assert v['reward_risk']>0
    assert math.isclose(v['stake_gbp'],50)
    import pytest
    with pytest.raises(ValueError):scenario(50,.004,.0041,.0042,.4,.1)
    with pytest.raises(ValueError):scenario(50,.004,.0046,.0038,25,.1)


def test_openhealth_and_input_validation(monkeypatch):
    assert client.get('/health').json()['quote']=='GBP'
    assert client.get('/').status_code==200
    assert 'RADAR' in client.get('/').text
    assert client.post('/api/calculate',json={'stake':50,'entry':.004,'target':.0047,'stop':.0037}).status_code==200
    assert client.post('/api/calculate',json={'stake':50,'entry':.004,'target':.003,'stop':.0037}).status_code==422
    assert client.post('/api/scan',json={'pairs':[]}).status_code==422
    assert client.post('/api/scan',json={'pairs':['BEAMUSD'],'interval':999}).status_code==422


def test_endpoint_rejects_non_gbp(monkeypatch):
    def fake_gbp():return [{'id':'BEAMGBP','symbol':'BEAM/GBP'}],time.time()
    monkeypatch.setattr(kraken,'gbp_pairs',fake_gbp)
    assert client.get('/api/candles?pair=BEAMUSD').status_code==422
    assert client.get('/api/book?pair=BEAMUSD').status_code==422
    assert client.post('/api/scan',json={'pairs':['BEAMUSD']}).status_code==422


def test_public_endpoint_not_trading():
    assert all('order' not in r.path.lower() for r in app.routes if r.path.startswith('/api/'))


def test_live_routes_with_mocked_kraken_data(monkeypatch):
    def mocked_query(endpoint, params=None, ttl=0):
        if endpoint == 'AssetPairs':
            return sample_pairs(), time.time()
        if endpoint == 'Ticker':
            return {
                'BEAMGBP': {'a':['0.0031'],'b':['0.00309'],'c':['0.003095'],'o':'0.003',
                            'v':['30000','100000000'],'p':['0.003','0.0031'],
                            'h':['0.0035','0.0035'],'l':['0.0029','0.0029']}
            }, time.time()
        if endpoint == 'OHLC':
            bars = [
                [b['time'],str(b['open']),str(b['high']),str(b['low']),str(b['close']),str(b['close']),str(b['volume']),b['trades']]
                for b in sample_bars()
            ]
            return {'BEAMGBP':bars, 'last':str(int(time.time()))}, time.time()
        if endpoint == 'Depth':
            return {'BEAMGBP': {'bids': [['0.00309','100000',time.time()]],
                                'asks':[['0.00310','50000',time.time()]]}}, time.time()
        raise AssertionError('unexpected endpoint')
    monkeypatch.setattr(kraken, 'query', mocked_query)
    markets = client.get('/api/markets')
    assert markets.status_code==200
    assert markets.json()['markets'][0]['symbol']=='BEAM/GBP'
    assert markets.json()['markets'][0]['volume_gbp24'] > 0
    chart = client.get('/api/candles?pair=BEAMGBP&interval=15')
    assert chart.status_code==200
    assert chart.json()['latest_is_forming'] is True
    assert chart.json()['complete_count']==len(chart.json()['candles'])-1
    book=client.get('/api/book?pair=BEAMGBP')
    assert book.status_code==200 and book.json()['quote']=='GBP'
    assert book.json()['bids'][0]['total_gbp'] > 0
    scan=client.post('/api/scan',json={'pairs':['BEAMGBP'],'interval':15})
    assert scan.status_code==200
    result=scan.json()['results'][0]
    assert result['quote']=='GBP'
    assert result['bars_used']==len(chart.json()['candles'])-1
    assert result['status'] in ('SETUP','WATCH','BLOCKED','NO SETUP','NO DATA')
