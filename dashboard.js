// Netlify Serverless Function
// 安全调用飞书API获取服务台工单数据

const https = require('https');

// 飞书API配置（请替换为你的实际配置）
const FEISHU_CONFIG = {
  appId: process.env.FEISHU_APP_ID || 'cli_a95da8bf81b85bd9',
  appSecret: process.env.FEISHU_APP_SECRET || 'UF1TXIiGPNWbUax1jC7X9gIFaTV6wQ4b',
  helpdeskId: process.env.FEISHU_HELPDESK_ID || '7036997285364023297',
  helpdeskToken: process.env.FEISHU_HELPDESK_TOKEN || 'ht-eeba8848-4143-0957-fd55-c788f47eb990',
  bitableAppToken: 'Ds5qb6T8aaPTmVsDipbcL8xUnyf',
  bitableTableId: 'tblmUcZPVbQWb9BG'
};

// 获取飞书 tenant_access_token
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      app_id: FEISHU_CONFIG.appId,
      app_secret: FEISHU_CONFIG.appSecret
    });

    const options = {
      hostname: 'open.feishu.cn',
      port: 443,
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result.tenant_access_token);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 获取多维表格记录
async function getBitableRecords(accessToken) {
  return new Promise((resolve, reject) => {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.bitableAppToken}/tables/${FEISHU_CONFIG.bitableTableId}/records?page_size=500`;
    
    const options = {
      hostname: 'open.feishu.cn',
      port: 443,
      path: url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result.data?.items || []);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// 处理工单数据，生成仪表盘统计
function processTicketData(records) {
  const stats = {
    total: records.length,
    resolved: 0,
    processing: 0,
    satisfaction: {满意: 0, 一般: 0, 不满意: 0, 未评分: 0},
    channels: {},
    dailyTrend: {},
    responseTime: {within1min: 0, within5min: 0, within15min: 0, within30min: 0, over30min: 0},
    highFrequency: {},
    updateTime: new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})
  };

  records.forEach(record => {
    const fields = record.fields || {};
    
    // 工单状态
    const status = fields['工单状态'];
    if (status === '已解决' || status === '已关闭') {
      stats.resolved++;
    } else {
      stats.processing++;
    }
    
    // 满意度
    const score = fields['工单评分'] || '未评分';
    if (score in stats.satisfaction) {
      stats.satisfaction[score]++;
    }
    
    // 渠道分布
    const channel = fields['工单渠道'] || '未知';
    stats.channels[channel] = (stats.channels[channel] || 0) + 1;
    
    // 每日趋势
    const createTime = fields['工单创建时间'];
    if (createTime) {
      const date = new Date(createTime);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      stats.dailyTrend[dateStr] = (stats.dailyTrend[dateStr] || 0) + 1;
    }
    
    // 响应时效
    const responseInterval = fields['客服首次回复时间间隔（秒）'];
    if (responseInterval !== undefined && responseInterval !== null && responseInterval !== '') {
      const seconds = parseFloat(responseInterval);
      if (seconds <= 60) stats.responseTime.within1min++;
      else if (seconds <= 300) stats.responseTime.within5min++;
      else if (seconds <= 900) stats.responseTime.within15min++;
      else if (seconds <= 1800) stats.responseTime.within30min++;
      else stats.responseTime.over30min++;
    }
    
    // 高频问题（从聊天记录中提取）
    const chatRecord = fields['聊天记录'] || '';
    if (chatRecord) {
      const matches = chatRecord.match(/问题类型[:：]\s*([^\n，,]+)/gi);
      if (matches) {
        matches.forEach(match => {
          const type = match.replace(/问题类型[:：]\s*/i, '').trim();
          if (type && type.length < 20) {
            stats.highFrequency[type] = (stats.highFrequency[type] || 0) + 1;
          }
        });
      }
    }
  });

  // 排序高频问题
  stats.highFrequency = Object.entries(stats.highFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .reduce((obj, [key, value]) => ({...obj, [key]: value}), {});

  // 计算解决率
  stats.resolutionRate = stats.total > 0 
    ? ((stats.resolved / stats.total) * 100).toFixed(1) + '%' 
    : '0%';

  // 计算满意率（只计算已评分的）
  const ratedTotal = stats.satisfaction.满意 + stats.satisfaction.一般 + stats.satisfaction.不满意;
  stats.satisfactionRate = ratedTotal > 0 
    ? ((stats.satisfaction.满意 / ratedTotal) * 100).toFixed(1) + '%' 
    : '0%';

  return stats;
}

// Netlify Function Handler
exports.handler = async (event, context) => {
  try {
    console.log('Fetching ticket data from Feishu...');
    
    // 获取 access token
    const accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error('Failed to get access token');
    }
    
    // 获取多维表格数据
    const records = await getBitableRecords(accessToken);
    console.log(`Fetched ${records.length} records`);
    
    // 处理数据
    const stats = processTicketData(records);
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        data: stats
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
